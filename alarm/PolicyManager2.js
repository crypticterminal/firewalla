/*    Copyright 2016 Firewalla LLC / Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

const log = require('../net2/logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const audit = require('../util/audit.js');
const util = require('util');
const Bone = require('../lib/Bone.js');

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const Promise = require('bluebird');

const minimatch = require('minimatch')

const SysManager = require('../net2/SysManager.js')
const sysManager = new SysManager('info');

let instance = null;

const policyActiveKey = "policy_active";

const policyIDKey = "policy:id";
const policyPrefix = "policy:";
const initID = 1;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const extend = require('util')._extend;

const Block = require('../control/Block.js');

const Policy = require('./Policy.js');

const HostTool = require('../net2/HostTool.js')
const ht = new HostTool()

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const DomainIPTool = require('../control/DomainIPTool.js');
const domainIPTool = new DomainIPTool();

const domainBlock = require('../control/DomainBlock.js')()

const categoryBlock = require('../control/CategoryBlock.js')()

const scheduler = require('../extension/scheduler/scheduler.js')()

const Queue = require('bee-queue')

const platform = require('../platform/PlatformLoader.js').getPlatform();
const policyCapacity = platform.getPolicyCapacity();

const EM = require('./ExceptionManager.js');
const em = new EM();

const _ = require('lodash')

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t);
  });
}

class PolicyManager2 {
  constructor() {
    if (instance == null) {
      instance = this;

      scheduler.enforceCallback = (policy) => {
        return this._enforce(policy)
      }

      scheduler.unenforceCallback = (policy) => {
        return this._unenforce(policy)
      }

      this.enabledTimers = {}
      
    }
    return instance;
  }
  
  shouldFilter(rule) {
    // this is to filter legacy schedule rules that is not compatible with current system any more
    // all legacy rules should already been migrated in OldDataCleanSensor, any leftovers should be bug
    // and here is a protection for that
    if(rule.cronTime && rule.cronTime.startsWith("* *")) {
      return true;
    }   
    return false;   
  }

  setupPolicyQueue() {
    this.queue = new Queue('policy', {
      removeOnFailure: true,
      removeOnSuccess: true
    });

    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })

    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.name} failed with error ${err.message}`);
    });

    this.queue.destroy(() => {
      log.info("policy queue is cleaned up")
    })

    this.queue.process((job, done) => {
      const event = job.data;
      const policy = new Policy(event.policy);
      const oldPolicy = event.oldPolicy ? new Policy(event.oldPolicy) : null;
      const action = event.action
      
      if(this.shouldFilter(policy)) {
        done();
        return;
      }

      switch(action) {
      case "enforce": {
        return async(() => {
          log.info("START ENFORCING POLICY", policy.pid, action);
          await(this.enforce(policy))
        })().catch((err) => {
          log.error("enforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE ENFORCING POLICY", policy.pid, action);
          done()
        })
        break
      }

      case "unenforce": {
        return async(() => {
          log.info("START UNENFORCING POLICY", policy.pid, action);
          await(this.unenforce(policy))
        })().catch((err) => {
          log.error("unenforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE UNENFORCING POLICY", policy.pid, action);
          done()
        })
        break
      }

      case "reenforce": {
        return async(() => {
          if(!oldPolicy) {
            // do nothing
          } else {
            log.info("START REENFORCING POLICY", policy.pid, action);

            await(this.unenforce(oldPolicy))
            await(this.enforce(policy))
          }
        })().catch((err) => {
          log.error("reenforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE ENFORCING POLICY", policy.pid, action);
          done()
        })
        break
      }

      case "incrementalUpdate": {
        return async(() => {
          const list = await (domainIPTool.getAllIPMappings())
          list.forEach((l) => {
            const matchDomain = l.match(/ipmapping:domain:(.*)/)
            if(matchDomain) {
              const domain = matchDomain[1]
              await (domainBlock.incrementalUpdateIPMapping(domain, {}))
              return
            } 

            const matchBlockSetDomain = l.match(/ipmapping:blockset:({^:}*):domain:(.*)/);
            if (matchBlockSetDomain) {
              const blockSet = matchBlockSetDomain[1];
              const domain = matchBlockSetDomain[2];
              await (domainBlock.incrementalUpdateIPMapping(domain, {blockSet: blockSet}))
              return;
            }
            
            const matchExactDomain = l.match(/ipmapping:exactdomain:(.*)/)
            if(matchExactDomain) {
              const domain = matchExactDomain[1]
              await (domainBlock.incrementalUpdateIPMapping(domain, {exactMatch: 1}))
              return
            }

            const matchBlockSetExactDomain = l.match(/ipmapping:blockset:({^:}*):exactdomain:(.*)/);
            if (matchBlockSetExactDomain) {
              const blockSet = matchBlockSetExactDomain[1];
              const domain = matchBlockSetExactDomain[2];
              await (domainBlock.incrementalUpdateIPMapping(domain, {exactMatch: 1, blockSet: blockSet}));
            }
          })
        })().catch((err) => {
          log.error("incremental update policy failed:", err);
        }).finally(() => {
          log.info("COMPLETE incremental update policy");
          done()
        })
      }

      default:
        log.error("unrecoganized policy enforcement action:" + action)
        done()
        break
      }
    })

    setInterval(() => {
      this.queue.checkHealth((error, counts) => {
        log.debug("Policy queue status:", counts);
      })
      
    }, 60 * 1000)
  }

  registerPolicyEnforcementListener() { // need to ensure it's serialized
    log.info("register policy enforcement listener")
    sem.on("PolicyEnforcement", (event) => {
      if (event && event.policy) {
        log.info("got policy enforcement event:" + event.action + ":" + event.policy.pid)
        if(this.queue) {
          const job = this.queue.createJob(event)
          job.timeout(60 * 1000).save(function() {})
        }
      }
    })
  }

  tryPolicyEnforcement(policy, action, oldPolicy) {
    if (policy) {
      action = action || 'enforce'
      log.info("try policy enforcement:" + action + ":" + policy.pid)

      sem.emitEvent({
        type: 'PolicyEnforcement',
        toProcess: 'FireMain',//make sure firemain process handle enforce policy event
        message: 'Policy Enforcement:' + action,
        action : action, //'enforce', 'unenforce', 'reenforce'
        policy : policy,
        oldPolicy: oldPolicy
      })
    }
  }

  createPolicyIDKey(callback) {
    rclient.set(policyIDKey, initID, callback);
  }

  getNextID(callback) {
    rclient.get(policyIDKey, (err, result) => {
      if(err) {
        log.error("Failed to get policyIDKey: " + err);
        callback(err);
        return;
      }

      if(result) {
        rclient.incr(policyIDKey, (err, newID) => {
          if(err) {
            log.error("Failed to incr policyIDKey: " + err);
          }
          callback(null, newID);
        });
      } else {
        this.createPolicyIDKey((err) => {
          if(err) {
            log.error("Failed to create policyIDKey: " + err);
            callback(err);
            return;
          }

          rclient.incr(policyIDKey, (err) => {
            if(err) {
              log.error("Failed to incr policyIDKey: " + err);
            }
            callback(null, initID);
          });
        });
      }
    });
  }

  addToActiveQueue(policy, callback) {
    //TODO
    let score = parseFloat(policy.timestamp);
    let id = policy.pid;
    rclient.zadd(policyActiveKey, score, id, (err) => {
      if(err) {
        log.error("Failed to add policy to active queue: " + err);
      }
      callback(err);
    });
  }

  // TODO: A better solution will be we always provide full policy data on calling this (requires mobile app update)
  // it's hard to keep sanity dealing with partial update and redis in the same time
  async updatePolicyAsync(policy) {
    if (!policy.pid)
      return Promise.reject(new Error("UpdatePolicyAsync requires policy ID"))

    const policyKey = policyPrefix + policy.pid;

    if (policy instanceof Policy) {
      let redisfied = policy.redisfy();
      await rclient.hmsetAsync(policyKey, policy.redisfy());
      return;
    }

    let existing = await this.getPolicy(policy.pid);

    Object.assign(existing, policy);

    if(existing.target && existing.type) {
      switch(existing.type) {
        case "mac":
          existing.target = existing.target.toUpperCase(); // always upper case for mac address
          break;
        case "dns":
        case "domain":
          existing.target = existing.target.toLowerCase(); // always lower case for domain block
          break;
        default:
          // do nothing;
      }
    }

    await rclient.hmsetAsync(policyKey, existing.redisfy());

    if (policy.expire === '') {
      await rclient.hdelAsync(policyKey, "expire");
    }
    if (policy.cronTime === '') {
      await rclient.hdelAsync(policyKey, "cronTime");
      await rclient.hdelAsync(policyKey, "duration");
    }
    if (policy.activatedTime === '') {
      await rclient.hdelAsync(policyKey, "activatedTime");
    }
    if (policy.hasOwnProperty('scope') && _.isEmpty(policy.scope) ) {
      await rclient.hdelAsync(policyKey, "scope");
    }
  }

  savePolicyAsync(policy) {
    return new Promise((resolve, reject) => {
      this.savePolicy(policy, (err) => {
        if(err)
          reject(err);

        resolve();
      })
    })
  }

  savePolicy(policy, callback) {
    callback = callback || function() {}

    log.info("In save policy:", policy);

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      policy.pid = id + ""; // convert to string

      let policyKey = policyPrefix + id;

      rclient.hmset(policyKey, policy.redisfy(), (err) => {
        if(err) {
          log.error("Failed to set policy: " + err);
          callback(err);
          return;
        }

        this.addToActiveQueue(policy, (err) => {
          if(!err) {
            audit.trace("Created policy", policy.pid);
          }
          this.tryPolicyEnforcement(policy)
          callback(null, policy)
        });

        Bone.submitIntelFeedback('block', policy, 'policy');
      });
    });
  }

  checkAndSave(policy, callback) {
    callback = callback || function() {}
    if (!policy instanceof Policy) callback(new Error("Not Policy instance"));
    async(()=>{
      //FIXME: data inconsistence risk for multi-processes or multi-threads
      try {
        if(this.isFirewallaOrCloud(policy)) {
          callback(new Error("To keep Firewalla Box running normally, Firewalla Box or Firewalla Cloud can't be blocked."));
          return
        }
        let policies = await(this.getSamePolicies(policy))
        if (policies && policies.length > 0) {
          log.info("policy with type:" + policy.type + ",target:" + policy.target + " already existed")
          const samePolicy = policies[0]
          if(samePolicy.disabled && samePolicy.disabled == "1") {
            // there is a policy in place and disabled, just need to enable it
            await (this.enablePolicy(samePolicy))
            callback(null, samePolicy, "duplicated_and_updated")
          } else {
            callback(null, samePolicy, "duplicated")
          }
        } else {
          this.savePolicy(policy, callback);
        }
      } catch (err) {
        log.error("failed to save policy:" + err)
        callback(err)
      }
    })()
  }

  checkAndSaveAsync(policy) {
    return new Promise((resolve, reject) => {
      this.checkAndSave(policy, (err, resultPolicy) => {
        if(err) {
          reject(err)
        } else {
          resolve(resultPolicy)
        }
      })
    })
  }

  policyExists(policyID) {
    return new Promise((resolve, reject) => {
      rclient.keys(policyPrefix + policyID, (err, result) => {
        if(err) {
          reject(err);
          return;
        }

        resolve(result !== null);
      });
    });
  }

  getPolicy(policyID) {
    return new Promise((resolve, reject) => {
      this.idsToPolicies([policyID], (err, results) => {
        if(err) {
          reject(err);
          return;
        }

        if(results == null || results.length === 0) {
          resolve(null)
          return
        }

        resolve(results[0]);
      });
    });
  }

  async getSamePolicies(policy) {
    let policies = await this.loadActivePoliciesAsync({ includingDisabled: true });

    if (policies) {
      return policies.filter((p) => policy.isEqualToPolicy(p))
    }
  }

  // These two enable/disable functions are intended to be used by all nodejs processes, not just FireMain
  // So cross-process communication is used
  // the real execution is on FireMain, check out _enablePolicy and _disablePolicy below
  enablePolicy(policy) {
    return async(() => {
      if(policy.disabled != '1') {
        return policy // do nothing, since it's already enabled
      }
      await (this._enablePolicy(policy))
      this.tryPolicyEnforcement(policy, "enforce")
      Bone.submitIntelFeedback('enable', policy, 'policy')
      return policy
    })()
  }

  disablePolicy(policy) {
    return async(() => {
      if(policy.disabled == '1') {
        return // do nothing, since it's already disabled
      }
      await (this._disablePolicy(policy))
      this.tryPolicyEnforcement(policy, "unenforce")
      Bone.submitIntelFeedback('disable', policy, 'policy')
    })()
  }

  disableAndDeletePolicy(policyID) {
    return async(() => {
      let policy = await (this.getPolicy(policyID))

      if(!policy) {
        return Promise.resolve()
      }

      await (this.deletePolicy(policyID)) // delete before broadcast

      this.tryPolicyEnforcement(policy, "unenforce")
      Bone.submitIntelFeedback('unblock', policy, 'policy');
    })()
  }

  getPolicyKey(pid) {
    return policyPrefix + pid;
  }

  // for autoblock revalidation dry run only
  async markAsShouldDelete(policyID) {
    const policy = await this.getPolicy(policyID);

    if(!policy) {
      return;
    }

    return rclient.hsetAsync(this.getPolicyKey(policyID), "shouldDelete", "1");
  }

  deletePolicy(policyID) {
    log.info("Trying to delete policy " + policyID);
    return this.policyExists(policyID)
      .then((exists) => {
        if(!exists) {
          log.error("policy " + policyID + " doesn't exists");
          return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
          let multi = rclient.multi();

          multi.zrem(policyActiveKey, policyID);
          multi.del(policyPrefix + policyID);
          multi.exec((err) => {
            if(err) {
              log.error("Fail to delete policy: " + err);
              reject(err);
              return;
            }

            resolve();
          })
        });
      });
  }

  // await all async opertions here to ensure errors are caught
  async deleteMacRelatedPolicies(mac) {
    // device specified policy
    await rclient.delAsync('policy:mac:' + mac);

    let rules = await this.loadActivePoliciesAsync({includingDisabled: 1})
    let policyIds = [];
    let policyKeys = [];

    for (let rule of rules) {
      if (_.isEmpty(rule.scope)) continue;

      if (rule.scope.some(m => m == mac)) {
        // rule targets only deleted device
        if (rule.scope.length <= 1) {
          policyIds.push(rule.pid);
          policyKeys.push('policy:' + rule.pid);

          this.tryPolicyEnforcement(rule, 'unenforce');
        }
        // rule targets NOT only deleted device
        else {
          let reducedScope = _.without(rule.scope, mac);
          await rclient.hsetAsync('policy:' + rule.pid, 'scope', JSON.stringify(reducedScope));
          const newRule = await this.getPolicy(rule.pid)

          this.tryPolicyEnforcement(newRule, 'reenforce', rule);

          log.info('remove scope from policy:' + rule.pid, mac);
        }
      }
    }

    if (policyIds.length) { // policyIds & policyKeys should have same length
      await rclient.delAsync(policyKeys);
      await rclient.zremAsync(policyActiveKey, policyIds);
    }
    log.info('Deleted', mac, 'related policies:', policyKeys);
  }

  idsToPolicies(ids, callback) {
    let multi = rclient.multi();

    ids.forEach((pid) => {
      multi.hgetall(policyPrefix + pid);
    });

    multi.exec((err, results) => {
      if(err) {
        log.error("Failed to load active policies (hgetall): " + err);
        callback(err);
        return;
      }

      let rr = results
        .map(r => {
          if (!r) return null;

          let p = null;
          try {
            p = new Policy(r)
          } catch(e) {
            log.error(e, r);
          } finally {
            return p;
          }
        })
        .filter(r => r != null)

      // recent first
      rr.sort((a, b) => {
        return b.timestamp > a.timestamp
      })

      callback(null, rr)

    });
  }

  loadRecentPolicies(duration, callback) {
    if(typeof(duration) == 'function') {
      callback = duration;
      duration = 86400;
    }

    callback = callback || function() {}

    let scoreMax = new Date() / 1000 + 1;
    let scoreMin = scoreMax - duration;
    rclient.zrevrangebyscore(policyActiveKey, scoreMax, scoreMin, (err, policyIDs) => {
      if(err) {
        log.error("Failed to load active policies: " + err);
        callback(err);
        return;
      }

      this.idsToPolicies(policyIDs, callback);
    });
  }

  numberOfPolicies(callback) {
    callback = callback || function() {}

    rclient.zcount(policyActiveKey, "-inf", "+inf", (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      // TODO: support more than 20 in the future
      callback(null, result > 20 ? 20 : result);
    });
  }

  loadActivePoliciesAsync(options) {
    return new Promise((resolve, reject) => {
      this.loadActivePolicies(options, (err, policies) => {
        if(err) {
          reject(err)
        } else {
          resolve(policies)
        }
      })
    })
  }
  
  // we may need to limit number of policy rules created by user
  loadActivePolicies(options, callback) {

    if(typeof options === 'function') {
      callback = options;
      options = {};
    }

    options = options || {};
    let number = options.number || policyCapacity;
    callback = callback || function() {};

    rclient.zrevrange(policyActiveKey, 0, number -1 , (err, results) => {
      if(err) {
        log.error("Failed to load active policies: " + err);
        callback(err);
        return;
      }

      this.idsToPolicies(results, (err, policyRules) => {
        if(options.includingDisabled) {
          callback(err, policyRules)
        } else {
          callback(err, policyRules.filter((r) => r.disabled != "1")) // remove all disabled one
        }
      });
    });
  }

  // cleanup before use
  cleanupPolicyData() {
    return async(() => {
      await (domainIPTool.removeAllDomainIPMapping())
    })() 
  }

  async enforceAllPolicies() {
    let rules = await this.loadActivePoliciesAsync();

    rules.forEach((rule) => {
      try {
        if(this.queue) {
          const job = this.queue.createJob({
            policy: rule,
            action: "enforce",
            booting: true
          })
          job.timeout(60000).save(function() {})
        }
      } catch(err) {
        log.error(`Failed to enforce policy ${rule.pid}: ${err}`)
      }
    })
    log.info("All policy rules are enforced")
  }


  async parseDevicePortRule(target) {
    let matches = target.match(/(.*):(\d+):(tcp|udp)/)
    if(matches) {
      let mac = matches[1];
      let host = await ht.getMACEntry(mac);
      if(host) {
        return {
          ip: host.ipv4Addr,
          port: matches[2],
          protocol: matches[3]
        }
      } else {
        return null
      }
    } else {
      return null
    }

  }
    
  isFirewallaOrCloud(policy) {
    const target = policy.target

    return sysManager.isMyServer(target) ||
           sysManager.myIp() === target ||
           sysManager.myIp2() === target ||
           // compare mac, ignoring case
           target.substring(0,17) // devicePort policies have target like mac:protocol:prot
             .localeCompare(sysManager.myMAC(), undefined, {sensitivity: 'base'}) === 0 ||
           target === "firewalla.encipher.com" ||
           target === "firewalla.com" ||
           minimatch(target, "*.firewalla.com")
  }

  enforce(policy) {
    if(policy.disabled == 1) {
      return // ignore disabled policy rules
    }
    
    // auto unenforce if expire time is set
    if(policy.expire) {
      if(policy.willExpireSoon())  {
        // skip enforce as it's already expired or expiring
        return async(() => {
          await (delay(policy.getExpireDiffFromNow() * 1000 ))
          await (this._disablePolicy(policy))
          if(policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
            await (this.deletePolicy(policy.pid))
          }
        })()
        log.info(`Skip policy ${policy.pid} as it's already expired or expiring`)
      } else {
        return async(() => {
          await (this._enforce(policy))
          log.info(`Will auto revoke policy ${policy.pid} in ${Math.floor(policy.getExpireDiffFromNow())} seconds`)
          const pid = policy.pid          
          const policyTimer = setTimeout(() => {
            async(() => {
              log.info(`About to revoke policy ${pid} `)
              // make sure policy is still enabled before disabling it
              const policy = await (this.getPolicy(pid))

              // do not do anything if policy doesn't exist any more or it's disabled already
              if(!policy || policy.isDisabled()) {
                return
              }

              log.info(`Revoke policy ${policy.pid}, since it's expired`)
              await (this.unenforce(policy));
              await (this._disablePolicy(policy))
              if(policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
                await (this.deletePolicy(pid))
              }
            })()
          }, policy.getExpireDiffFromNow() * 1000) // in milli seconds, will be set to 1 if it is a negative number

          this.invalidateExpireTimer(policy) // remove old one if exists
          this.enabledTimers[pid] = policyTimer
        })()
      }
    } else if (policy.cronTime) {
      // this is a reoccuring policy, use scheduler to manage it
      return scheduler.registerPolicy(policy)
    } else {
      return this._enforce(policy) // regular enforce
    }
  }

  // this is the real execution of enable and disable policy
  _enablePolicy(policy) {
    return async(() => {
      const now = new Date() / 1000
      await (this.updatePolicyAsync({
        pid: policy.pid,
        disabled: 0,
        activatedTime: now
      }))
      policy.disabled = 0
      policy.activatedTime = now
      log.info(`Policy ${policy.pid} is enabled`)
      return policy
    })()
  }

  _disablePolicy(policy) {
    return async(() => {
      await (this.updatePolicyAsync({
        pid: policy.pid,
        disabled: 1 // flag to indicate that this policy is revoked successfully.
      }))
      policy.disabled = 1
      log.info(`Policy ${policy.pid} is disabled`)
      return policy
    })()
  }

  _refreshActivatedTime(policy) {
    return async(() => {
      const now = new Date() / 1000
      let activatedTime = now;
      // retain previous activated time, this happens if policy is not deactivated normally, e.g., reboot, restart
      if (policy.activatedTime) {
        activatedTime = policy.activatedTime;
      }
      await (this.updatePolicyAsync({
        pid: policy.pid,
        activatedTime: activatedTime
      }))
      policy.activatedTime = activatedTime
      return policy
    })()
  }

  async _removeActivatedTime(policy) {

    const p = await this.getPolicy(policy.pid);

    if(!p) { // no need to update policy if policy is already deleted
      return;
    }

    await this.updatePolicyAsync({
      pid: policy.pid,
      activatedTime: ""
    })

    delete policy.activatedTime;
    return policy;
  }

  async _enforce(policy) {
    log.debug("Enforce policy: ", policy);
    log.info("Enforce policy: ", policy.pid, policy.type, policy.target, policy.scope, policy.whitelist);

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    await this._refreshActivatedTime(policy)

    if (this.isFirewallaOrCloud(policy)) {
      return Promise.reject(new Error("Firewalla and it's cloud service can't be blocked."))
    }

    const scope = policy.scope

    switch(type) {
      case "ip":
        if(scope) {
          return Block.advancedBlock(policy.pid, policy.pid, scope, [policy.target], policy.whitelist)
        } else {
          if (policy.whitelist) {
            await Block.enableGlobalWhitelist();
            return Block.block(policy.target, "whitelist_ip_set");
          } else {
            return Block.block(policy.target)
          }
        }
        break;
      case "mac":
        if (policy.whitelist) {
          await Block.enableGlobalWhitelist();
          return Block.blockMac(policy.target, "whitelist_mac_set");
        } else {
          return Block.blockMac(policy.target);
        }
        break;
      case "domain":
      case "dns":
        if(scope) {
          await Block.advancedBlock(policy.pid, policy.pid, scope, [], policy.whitelist);
          return domainBlock.blockDomain(policy.target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(policy.pid),
            no_dnsmasq_entry: true,
            no_dnsmasq_reload: true
          })
        } else {
          let options = {exactMatch: policy.domainExactMatch};
          if (policy.whitelist) {
            options.blockSet = "whitelist_domain_set";
            // whitelist rule should not add dnsmasq filter rule
            options.no_dnsmasq_entry = true;
            options.no_dnsmasq_reload = true;
            await Block.enableGlobalWhitelist();
          }
          return domainBlock.blockDomain(policy.target, options);
        }

        break;
      case "devicePort":
        let data = await this.parseDevicePortRule(policy.target);
        if(data) {
          if (policy.whitelist) {
            await Block.enableGlobalWhitelist();
            return Block.blockPublicPort(data.ip, data.port, data.protocol, "whitelist_ip_port_set");
          } else {
            return Block.blockPublicPort(data.ip, data.port, data.protocol)
          }
        }
        break;
      case "category":
        if(scope) {
          // same category shares same dst tag
          return Block.advancedBlock(policy.pid, policy.target, scope, [], policy.whitelist);
        } else {
          let options = {};
          if (policy.whitelist) {
            options.whitelist = true;
            await Block.enableGlobalWhitelist();
          }
          return categoryBlock.blockCategory(policy.target, options);
        }
        break;

      default:
        return Promise.reject("Unsupported policy");
    }

  }

  invalidateExpireTimer(policy) {
    const pid = policy.pid
    if(this.enabledTimers[pid]) {
      log.info("Invalidate expire timer for policy", pid);
      clearTimeout(this.enabledTimers[pid])
      delete this.enabledTimers[pid]
    }    
  }

  unenforce(policy) {
    if (policy.cronTime) {
      // this is a reoccuring policy, use scheduler to manage it
      return scheduler.deregisterPolicy(policy)
    } else {
      this.invalidateExpireTimer(policy) // invalidate timer if exists
      return this._unenforce(policy) // regular unenforce
    }
  }

  async _unenforce(policy) {
    log.info("Unenforce policy: ", policy.pid, policy.type, policy.target);

    await this._removeActivatedTime(policy)

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    const scope = policy.scope

    switch(type) {
      case "ip":
        if(scope) {
          return Block.advancedUnblock(policy.pid, policy.pid, scope, [policy.target], policy.whitelist, true)
        } else {
          if (policy.whitelist) {
            await Block.disableGlobalWhitelist();
            return block.unblock(policy.target, "whitelist_ip_set");
          } else {
            return Block.unblock(policy.target)
          }
        }
        break;
      case "mac":
        if (policy.whitelist) {
          await Block.disableGlobalWhitelist();
          return Block.unblockMac(policy.target, "whitelist_mac_set");
        } else {
          return Block.unblockMac(policy.target)
        }
        break;
      case "domain":
      case "dns":
        if(scope) {
          await (domainBlock.unblockDomain(policy.target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(policy.pid),
            no_dnsmasq_entry: true,
            no_dnsmasq_reload: true
          }))
          // destroy domain dst cache, since there may be various domain dst cache in different policies
          return Block.advancedUnblock(policy.pid, policy.pid, scope, [], policy.whitelist, true)
        } else {
          let options = {exactMatch: policy.domainExactMatch};
          if (policy.whitelist) {
            options.blockSet = "whitelist_domain_set";
            options.no_dnsmasq_entry = true;
            options.no_dnsmasq_reload = true;
            await Block.disableGlobalWhitelist();
          }
          return domainBlock.unblockDomain(policy.target, options);
        }

        break;
      case "devicePort":
        let data = await (this.parseDevicePortRule(policy.target))
        if(data) {
          if (policy.whitelist) {
            await Block.disableGlobalWhitelist();
            return Block.unblockPublicPort(data.ip, data.port, data.protocol, "whitelist_ip_port_set");
          } else {
            return Block.unblockPublicPort(data.ip, data.port, data.protocol);
          }
        }
        break;
      case "category":
        if(scope) {
          // keep category dst cache since the number of predefined categories is limited
          return Block.advancedUnblock(policy.pid, policy.target, scope, [], policy.whitelist, false);
        } else {
          let options = {};
          if (policy.whitelist) {
            options.whitelist = true;
            await Block.disableGlobalWhitelist();
          }
          return categoryBlock.unblockCategory(policy.target, options);
        }

      default:
        return Promise.reject("Unsupported policy");
    }
  }

  match(alarm, callback) {
    this.loadActivePolicies((err, policies) => {
      if(err) {
        log.error("Failed to load active policy rules")
        callback(err)
        return
      }

      const matchedPolicies = policies.filter((policy) => {
        return policy.match(alarm)
      })
      
      if(matchedPolicies.length > 0) {
        callback(null, true)
      } else {
        callback(null, false)  
      }
    })
  }


  // utility functions
  async findPolicy(target, type) {
    let rules = await this.loadActivePoliciesAsync();

    for (const index in rules) {
      const rule = rules[index]
      if(rule.target === target && type === rule.type) {
        return rule
      }
    }

    return null
  }
}

module.exports = PolicyManager2;
