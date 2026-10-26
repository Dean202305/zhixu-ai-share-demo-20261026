/* Public preview only. No server, credentials, external messages or real AI calls. */
(() => {
  'use strict';
  const KEY = 'zhixu-share-preview-v1';
  const clone = value => JSON.parse(JSON.stringify(value));
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!state || state.schema_version !== 1) state = clone(window.ZHIXU_DEMO_FIXTURES);
  const originalFetch = window.fetch.bind(window);
  const id = () => crypto.randomUUID();
  const now = () => new Date().toISOString();
  const later = ms => new Date(Date.now() + ms).toISOString();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json', 'cache-control':'no-store' } });
  const fail = (detail, status=403) => { const error = new Error(detail); error.status = status; throw error; };
  const allPermissions = () => state.permissions_catalog.map(p => p.key);
  const allRoles = () => state.role_catalog.map(r => r.key);
  const level = {SUPER_ADMIN:0, ADMIN_L1:1, ADMIN_L2:2, EMPLOYEE:3};
  const account = uid => state.accounts.find(a => a.user_id === uid);
  const caseById = cid => state.overview.alignment_cases.find(c => c.id === cid);
  const isBelow = (child,parent) => {
    const seen = new Set(); let node = account(child);
    while (node && node.manager_user_id && !seen.has(node.user_id)) {
      seen.add(node.user_id); if (node.manager_user_id === parent) return true;
      node = account(node.manager_user_id);
    } return false;
  };
  const intersect = (a,b) => a.filter(x => b.includes(x));
  const subset = (a,b) => a.every(x => b.includes(x));
  function effective(uid) {
    const own=account(uid); if(!own) fail('演示账号不存在',404);
    let permissions=[...own.permissions], roles=[...own.role_keys], delegates=[...own.delegable_permissions], rolePool=[...own.delegable_role_keys];
    let active=true, current=own; const seen=new Set();
    while(current) {
      if(seen.has(current.user_id) || current.status!=='ACTIVE') { active=false; break; }
      seen.add(current.user_id);
      if(current.admin_level==='SUPER_ADMIN') {
        if(current===own) { permissions=allPermissions(); delegates=allPermissions(); rolePool=allRoles(); }
        break;
      }
      const parent=account(current.manager_user_id);
      if(!parent || level[parent.admin_level]>=level[current.admin_level]) { active=false; break; }
      if(parent.admin_level!=='SUPER_ADMIN') {
        permissions=intersect(permissions,parent.delegable_permissions);
        delegates=intersect(delegates,parent.delegable_permissions);
        roles=intersect(roles,parent.delegable_role_keys);
        rolePool=intersect(rolePool,parent.delegable_role_keys);
      } current=parent;
    }
    if(own.admin_level==='EMPLOYEE') { delegates=[]; rolePool=[]; }
    return { active, permissions:active?permissions:[], roles:active?roles:[], delegates:active?intersect(delegates,permissions):[], rolePool:active?rolePool:[] };
  }
  function check(uid, permission) {
    const own=account(uid), policy=effective(uid);
    if(!policy.active || (permission && !policy.permissions.includes(permission))) fail('当前演示身份没有此操作权限');
    return own;
  }
  function accountResult(item) {
    const policy=effective(item.user_id);
    return { ...clone(item), manager_display_name:account(item.manager_user_id)?.display_name||null,
      effective_active:policy.active, effective_permissions:policy.permissions, effective_role_keys:policy.roles,
      effective_delegable_permissions:policy.delegates, effective_delegable_role_keys:policy.rolePool, has_password:false };
  }
  function audit(uid, action, resource_id) {
    const entry={id:id(), action, resource_id, resource_type:'demo', metadata:{is_demo:true}, actor_user_id:uid, created_at:now()};
    state.overview.audit.unshift(entry); return entry;
  }
  function workspace(cid) {
    const c=caseById(cid), w=state.workspaces[cid];
    if(!c||!w) fail('演示事项不存在',404); w.case=c; return w;
  }
  function createCase(body,uid) {
    check(uid,'cases.create');
    if(!body.title?.trim()||!body.raw_goal?.trim()) fail('请填写事项标题和目标',422);
    const c={id:id(), title:body.title.trim(),raw_goal:body.raw_goal.trim(),state:'DRAFT',due_at:body.due_at||null,version:1,initiator_user_id:uid,goal_confirmed:false,active_contract_version_id:null,structured_goal:{}};
    state.overview.alignment_cases.unshift(c);
    state.workspaces[c.id]={case:c,stakeholders:[],confirmations:[],contracts:[],work_items:[],evidence:[],audit:[audit(uid,'alignment_case.created',c.id)]};
    return c;
  }
  const trace = () => ({preferred_engine:'jev',used_engine:'mock',model:'share-demo-rules',fallback:true,fallback_reason:'jev_not_configured'});
  const normalizePhone = phone => { const p=String(phone||'').replace(/[\s()-]/g,''); return /^1[3-9]\d{9}$/.test(p)?'+86'+p:p; };
  function saveAccount(body,uid,targetId) {
    const own=check(uid,targetId?'accounts.edit':'accounts.create'), policy=effective(uid), superAdmin=own.admin_level==='SUPER_ADMIN';
    const old=targetId?account(targetId):null;
    if(targetId&&!old) fail('员工不存在',404);
    if(old&&body.expected_version!==old.version) fail('账号版本已变化，请刷新',409);
    if(!body.display_name?.trim()) fail('请输入员工姓名',422);
    const phone=normalizePhone(body.phone);
    if(!/^\+[1-9]\d{7,14}$/.test(phone)) fail('请输入有效的演示手机号',422);
    const roles=body.role_keys||[], permissions=body.permissions||[], delegates=body.delegable_permissions||[], rolePool=body.delegable_role_keys||[];
    if(!subset(roles.concat(rolePool),allRoles())||!subset(permissions.concat(delegates),allPermissions())) fail('包含未知岗位或权限',409);
    if(!subset(delegates,permissions)) fail('可下放权限必须在使用权限之内',409);
    const adminLevel=body.admin_level||'EMPLOYEE';
    if(!(adminLevel in level)) fail('未知账号级别',422);
    if(!superAdmin) {
      if(adminLevel!=='EMPLOYEE'||(old&&old.admin_level!=='EMPLOYEE')) fail('只有超管可设置管理员及管理员权限');
      if(old&&!isBelow(old.user_id,uid)) fail('只能管理本人下属');
      if(old&&old.manager_user_id!==body.manager_user_id) fail('管理归属只能由超管调整');
      if(!old||JSON.stringify(old.role_keys)!==JSON.stringify(roles)||JSON.stringify(old.permissions)!==JSON.stringify(permissions)) check(uid,'accounts.assign');
      if(old&&body.status!==old.status) check(uid,'accounts.disable');
      if(!subset(permissions,policy.delegates)||!subset(roles,policy.rolePool)) fail('超出当前可下放范围');
    }
    if(adminLevel==='EMPLOYEE'&&(delegates.length||rolePool.length)) fail('员工不能继续下放权限',409);
    const parent=body.manager_user_id?account(body.manager_user_id):null;
    if(adminLevel!=='SUPER_ADMIN') {
      if(!parent||!effective(parent.user_id).active||level[parent.admin_level]>=level[adminLevel]) fail('上级管理员级别或状态不符合要求',409);
      if(!superAdmin&&parent.user_id!==uid&&!isBelow(parent.user_id,uid)) fail('不能给其他团队开户');
      const p=effective(parent.user_id);
      if(!subset(permissions.concat(delegates),p.delegates)||!subset(roles.concat(rolePool),p.rolePool)) fail('超出直属上级的可下放范围',409);
      if(old&&(parent.user_id===old.user_id||isBelow(parent.user_id,old.user_id))) fail('管理层级不能循环',409);
    }
    if(old&&old.admin_level==='SUPER_ADMIN'&&(adminLevel!=='SUPER_ADMIN'||body.status!=='ACTIVE')&&state.accounts.filter(a=>a.admin_level==='SUPER_ADMIN'&&a.status==='ACTIVE').length<=1) fail('不能停用或降级最后一位有效超管',409);
    if(old&&state.accounts.some(a=>a.manager_user_id===old.user_id&&level[adminLevel]>=level[a.admin_level])) fail('请先移交下属再调整级别',409);
    if(state.accounts.some(a=>a.phone===phone&&a.user_id!==targetId)) fail('该手机号已存在',409);
    const identities=body.identities||[];
    const identityKey=i=>[i.provider,i.external_tenant_id,i.external_user_id].join('|');
    if(identities.some(i=>!['FEISHU','DINGTALK','WECOM','OA'].includes(i.provider)||!i.external_tenant_id||!i.external_user_id)) fail('请填写完整的软件身份',422);
    const keys=identities.map(identityKey);
    if(new Set(keys).size!==keys.length||state.accounts.some(a=>a.user_id!==targetId&&a.identities.some(i=>keys.includes(identityKey(i))))) fail('软件身份已绑定其他账号',409);
    if(!old&&body.request_id) { const previous=state.accounts.find(a=>a.request_id===body.request_id); if(previous) return accountResult(previous); }
    const clean={user_id:targetId||id(),display_name:body.display_name.trim(),phone,managed:true,admin_level:adminLevel,manager_user_id:adminLevel==='SUPER_ADMIN'?null:body.manager_user_id,status:body.status||'ACTIVE',role_keys:roles,permissions,delegable_permissions:delegates,delegable_role_keys:rolePool,identities,version:(old?.version||0)+1,has_password:false,request_id:body.request_id};
    if(old) Object.assign(old,clean); else state.accounts.push(clean);
    const member=state.overview.members.find(u=>u.user_id===clean.user_id);
    const memberFields={user_id:clean.user_id,display_name:clean.display_name,role:adminLevel==='SUPER_ADMIN'?'ADMIN':adminLevel==='EMPLOYEE'?'MEMBER':adminLevel};
    if(member) Object.assign(member,memberFields); else state.overview.members.push(memberFields);
    audit(uid,old?'account.updated':'account.created',clean.user_id);
    return accountResult(clean);
  }
  async function handle(path, method,body, uid) {
    if(path==='/api/account-session') return method==='POST'?reply({detail:'公开演示不启用真实登录，请载入演示体验。'},400):method==='DELETE'?reply({ok:true}):reply({detail:'分享演示无需登录'},401);
    if(path==='/api/v1/demo/bootstrap') return reply({organization_id:state.organization_id,initiator_user_id:state.admin_id,stakeholder_user_id:state.staff_id,hr_leader_user_id:state.overview.departments.find(d=>d.code==='hr').leader_user_id,finance_leader_user_id:state.overview.departments.find(d=>d.code==='finance').leader_user_id});
    check(uid);
    if(path==='/api/v1/account-management/session') return reply({organization_id:state.organization_id,user_id:uid,permissions:effective(uid).permissions});
    if(path==='/api/v1/organization-intelligence/overview') { check(uid,'workspace.read'); return reply(state.overview); }
    if(path==='/api/v1/account-management') {
      const own=account(uid), canManage=effective(uid).permissions.some(p=>p.startsWith('accounts.'));
      return reply({current_user_id:uid,current:accountResult(own),accounts:state.accounts.filter(a=>a.user_id===uid||(canManage&&(own.admin_level==='SUPER_ADMIN'||isBelow(a.user_id,uid)))).map(accountResult),permissions_catalog:state.permissions_catalog,role_catalog:state.role_catalog,level_labels:state.level_labels});
    }
    if(path==='/api/v1/account-management/accounts'&&method==='POST') return reply(saveAccount(body,uid),201);
    let match=path.match(/^\/api\/v1\/account-management\/accounts\/([^/]+)$/);
    if(match&&method==='PATCH') return reply(saveAccount(body,uid,match[1]));
    if(path==='/api/v1/ai/judgment-engine') return reply({preferred_engine:'jev',jev_configured:false,jev_model:'not-connected-in-share-demo',fallback_engine:'mock',fallback_is_mock:true});
    if(path==='/api/v1/alignment-cases') return method==='POST'?reply(createCase(body,uid),201):reply(state.overview.alignment_cases);
    match=path.match(/^\/api\/v1\/alignment-cases\/([^/]+)(\/.*)?$/);
    if(match) {
      const cid=match[1], action=match[2]||'', w=workspace(cid);
      if(action==='/workspace'||action==='') return reply(w.case&&action===''?w.case:w);
      if(action==='/ai/judgment-review') {
        check(uid,'ai.use'); if(w.case.initiator_user_id!==uid) fail('仅发起人可复核该事项');
        if(method==='GET') { const saved=state.reviews[cid]; return reply(saved?{...saved,stale:saved.case_version!==w.case.version}:null); }
        if(body.expected_case_version!==w.case.version) fail('事项已变化，请重新打开后分析',409);
        const saved={id:id(),case_id:cid,case_version:w.case.version,input_hash:'browser-demo',stale:false,analysis:trace(),created_at:now(),evidence_count:w.evidence.length,omitted_evidence_count:0,output:{schema_version:'1.0',risk_probabilities:{owner:w.stakeholders.length?.35:.8,deadline:w.case.due_at?.25:.6,dependency:.5,resource:.5,scope:.4},evidence_insufficient_probability:w.evidence.length?.3:.8,escalation_probability:w.case.state==='BLOCKED'?.8:.35}};
        state.reviews[cid]=saved; return reply(saved);
      }
    }
    match=path.match(/^\/api\/v1\/contracts\/([^/]+)\/confirmations$/);
    if(match&&method==='POST') {
      check(uid,'cases.update'); const w=Object.values(state.workspaces).find(w=>w.contracts.some(c=>c.id===match[1])); if(!w) fail('确认方案不存在',404);
      w.case=caseById(w.case.id); if(body.expected_case_version!==w.case.version) fail('方案已变化，请刷新',409);
      const party=w.stakeholders.find(p=>p.id===body.stakeholder_id&&p.user_id===uid); if(!party) fail('只能提交本人意见');
      if(!['AGREED','OBJECTED'].includes(body.status)) fail('需要明确同意或异议',422);
      const old=w.confirmations.find(c=>c.stakeholder_id===party.id&&c.contract_version_id===match[1]);
      const value={id:old?.id||id(),contract_version_id:match[1],stakeholder_id:party.id,status:body.status,comment:body.comment||null,confirmed_at:now()};
      if(old) Object.assign(old,value); else w.confirmations.push(value);
      w.case.version++; w.audit.unshift(audit(uid,'confirmation.recorded',w.case.id)); return reply(value);
    }
    if(path==='/api/v1/chat-intake/offers') return reply(state.offers.filter(o=>o.author_user_id===uid));
    if(path==='/api/v1/chat-intake/policies') {
      if(method==='GET') return reply(state.policies);
      if(account(uid).admin_level!=='SUPER_ADMIN') fail('切换为演示超管后可以启用会话');
      const old=state.policies.find(p=>p.chat_id===body.chat_id&&p.platform===body.platform);
      if(old) Object.assign(old,body); else state.policies.push({id:id(),...body});
      return reply(old||state.policies.at(-1));
    }
    if(path==='/api/v1/chat-intake/simulate') {
      check(uid,'chat.use'); const policy=state.policies.find(p=>p.chat_id===body.chat_id&&p.platform===body.platform);
      const skipped=reason=>reply({outcome:'SKIPPED',reason,offer:null,analysis:trace()});
      if(!policy?.enabled) return skipped('该演示会话尚未启用');
      const existing=state.offers.find(o=>o.message_id===body.message_id); if(existing) return reply({outcome:'INVITED',reason:existing.reason,offer:existing,analysis:trace()});
      if(state.offers.some(o=>o.author_user_id===uid&&o.chat_id===body.chat_id&&Date.now()-Date.parse(o.created_at)<600000)) return skipped('演示冷却期内，不重复打扰');
      const text=body.text||'';
      if(!/负责|验收|排期|上线|协调|依赖|资源|预算|配合|交付|确认.*时间/.test(text)) return skipped('未发现明确的工作协调问题');
      const category=/负责|验收/.test(text)?'OWNER':/时间|排期|上线|交付/.test(text)?'DEADLINE':/预算|资源/.test(text)?'RESOURCE':'DEPENDENCY';
      const offer={id:id(),author_user_id:uid,platform:body.platform,chat_id:body.chat_id,message_id:body.message_id,status:'PENDING',category,reason:'演示规则识别到需要相关人共同确认的工作问题',source_excerpt:text,case_id:null,created_at:now(),expires_at:later(1800000),is_demo:true,analysis:trace()};
      state.offers.unshift(offer); audit(uid,'chat.invitation_offered',offer.id); return reply({outcome:'INVITED',reason:offer.reason,offer,analysis:trace()});
    }
    match=path.match(/^\/api\/v1\/chat-intake\/offers\/([^/]+)\/decision$/);
    if(match) {
      const offer=state.offers.find(o=>o.id===match[1]); if(!offer) fail('演示邀请不存在',404);
      if(offer.author_user_id!==uid) fail('仅原提问人可以确认');
      const target=body.decision==='ACCEPT'?'ACCEPTED':'DECLINED';
      if(offer.status===target) return reply(offer);
      if(offer.status!=='PENDING'||Date.parse(offer.expires_at)<Date.now()) fail('邀请已处理或已过期',409);
      if(target==='ACCEPTED') { const c=createCase({title:offer.source_excerpt.slice(0,80),raw_goal:offer.source_excerpt},uid); offer.case_id=c.id; state.workspaces[c.id].evidence.push({id:id(),type:'CHAT_REQUEST',content_excerpt:offer.source_excerpt,source_provider:'DEMO_'+offer.platform}); }
      offer.status=target; return reply(offer);
    }
    for(const [prefix,collection,versioned] of [['/api/v1/department-hubs/',state.overview.hubs,true],['/api/v1/decision-makers/',state.overview.decision_makers,true]]) {
      if(path.startsWith(prefix)&&method==='PATCH') {
        check(uid,'organization.manage'); const item=collection.find(i=>i.id===path.slice(prefix.length)); if(!item) fail('对象不存在',404);
        if(body.expected_version!==item.version) fail('版本变化，请刷新',409);
        const {expected_version,...fields}=body; Object.assign(item,fields); if(versioned)item.version++; audit(uid,'organization.updated',item.id); return reply(item);
      }
    }
    if(path==='/api/v1/data-boundary-memories'&&method==='POST') {
      check(uid,'organization.manage'); const value={id:id(),owner_user_id:uid,...body,status:'ACTIVE',version:1,confirmed_at:now(),expires_at:later(2592000000)}; state.overview.data_boundary_memories.push(value); return reply(value,201);
    }
    if(path==='/api/v1/collaboration-channels'&&method==='POST') {
      check(uid,'collaboration.use'); if(body.source_executor_id===body.target_executor_id) fail('请选择不同执行者',409);
      const value={id:id(),...body,status:'PENDING_APPROVAL',approved_by_user_id:null}; state.overview.collaboration_channels.push(value); audit(uid,'collaboration_channel.created',value.id); return reply(value,201);
    }
    match=path.match(/^\/api\/v1\/collaboration-channels\/([^/]+)\/(approve|messages)$/);
    if(match) {
      check(uid,'collaboration.use'); const channel=state.overview.collaboration_channels.find(c=>c.id===match[1]); if(!channel)fail('通道不存在',404);
      if(match[2]==='approve') { channel.status='ACTIVE'; channel.approved_by_user_id=uid; return reply(channel); }
      const denied=body.sensitivity_level==='HIGH'&&body.sharing_mode==='RAW';
      return reply({id:id(),decision:denied?'DENY':channel.status==='ACTIVE'?'ALLOW':'REQUIRE_CONFIRMATION',reason_code:denied?'HIGH_RAW_DATA_CANNOT_TRAVEL':channel.status==='ACTIVE'?'DEMO_AUTHORIZED':'CHANNEL_REQUIRES_APPROVAL'});
    }
    if(path==='/api/v1/work-events'&&method==='POST') { check(uid,'memory.write');const value={id:id(),...body};state.overview.work_events.unshift(value);audit(uid,'work_event.created',value.id);return reply(value,201); }
    if(path==='/api/v1/role-memory-documents/generate') {
      check(uid,'memory.write'); const value={id:id(),...body,content_markdown:'# 岗位记忆候选稿 · 演示\n\n'+state.overview.work_events.filter(e=>e.department_id===body.department_id).map(e=>'## '+e.title+'\n'+e.summary).join('\n\n')+'\n\n此内容为浏览器内模拟汇总，需员工与负责人复核。',sensitivity_level:'LOW',status:'DRAFT',version:1};state.overview.role_memory_documents.unshift(value);audit(uid,'role_memory_document.generated',value.id);return reply(value);
    }
    return reply({detail:'此入口需要完整系统。当前公开预览仅模拟工作台主要交互。'},501);
  }
  window.fetch=async (input,init={}) => {
    const raw=typeof input==='string'||input instanceof URL?String(input):input.url;
    const url=new URL(raw,location.origin);
    const isApi=url.origin===location.origin&&(url.pathname.startsWith('/api/backend/')||url.pathname==='/api/account-session');
    if(!isApi) return originalFetch(input,init);
    if(init.signal?.aborted) throw new DOMException('Aborted','AbortError');
    try {
      const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));
      const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
      const text=typeof init.body==='string'?init.body:(input instanceof Request?await input.clone().text():'');
      const body=text?JSON.parse(text):{};
      const path=url.pathname.replace(/^\/api\/backend/,'');
      const org=headers.get('X-Organization-ID');
      if(org&&org!==state.organization_id) fail('演示组织不存在',403);
      const uid=headers.get('X-User-ID')||state.admin_id;
      const response=await handle(path,method,body,uid);
      if(response.ok&&method!=='GET') persist();
      return response;
    } catch(error) { return reply({detail:error.message||'演示操作未完成'},error.status||400); }
  };
  window.resetZhixuPreview=()=>{try{localStorage.removeItem(KEY);}catch{}location.reload();};
  if(typeof document!=='undefined') {
    const decorate=()=>{
      if(document.querySelector('.app-shell')&&!document.getElementById('share-preview-notice')) {
        const bar=document.createElement('aside'); bar.id='share-preview-notice'; bar.setAttribute('aria-label','公开演示说明');
        const label=document.createElement('span');label.textContent='公开交互演示 · 样例数据仅保存在本机';bar.append(label);
        const reset=document.createElement('button');reset.textContent='重置演示';reset.onclick=window.resetZhixuPreview;bar.append(reset);
        document.body.append(bar);
      }
      for(const input of document.querySelectorAll('.am-editor input[type="password"]')) { input.disabled=true;input.placeholder='公开演示不设置密码'; }
    };
    new MutationObserver(decorate).observe(document.documentElement,{childList:true,subtree:true});
    if(document.readyState!=='loading') decorate(); else document.addEventListener('DOMContentLoaded',decorate,{once:true});
  }
})();
