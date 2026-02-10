import fs from "node:fs";

function parse(p){
  const lines=fs.readFileSync(p,"utf8").split(/\r?\n/);
  const out=[];
  for(let i=0;i<lines.length;i++){
    const l=String(lines[i]||"").trim();
    if(l.startsWith("===")){
      const key=l.replace(/^===\s*/,"").trim();
      let j=i+1;
      while(j<lines.length && !String(lines[j]||"").trim()) j++;
      let obj=null;
      if(j<lines.length){
        try{ obj=JSON.parse(lines[j]); } catch(e){ obj={__parseErr:String(e), __raw:lines[j]}; }
      }
      out.push({ key, obj });
      i=j;
    }
  }
  return out;
}

const fullPath=process.argv[2];
const pfPath=process.argv[3];
if(!fullPath || !pfPath){
  console.error("missing args: node cover_check.js <fullPath> <pfPath>");
  process.exit(2);
}

const full=parse(fullPath);
const pf=parse(pfPath);

const pfReq = {
  prosecutor_police_impersonation: { anyTrig:["pf_visit_place","pf_urgency"] },
  safe_case: { minScore:18 },
  bank_impersonation: { minScore:18 },
  account_seizure: { minScore:18 },
  delivery_phishing: { minScore:18 },
  government_subsidy: { minScore:18 },
  invoice_tax: { minScore:18 },
  loan_scam: { minScore:18 },
  family_emergency: { minScore:18 },
  romance_investment: { anyTrig:["pf_contact_move"], minScore:18 },
  job_highpay_abroad: { anyTrig:["pf_contact_move","pf_visit_place"], minScore:18 },
  messenger_phishing: { minScore:18 },
  gifticon_market: { anyTrig:["pf_giftcard"], minScore:18 },
};

const fullReq = {
  prosecutor_police_impersonation: { anySig:["ctx_visit_place","urgent"] },
  safe_case: { anySig:["transfer"] },
  bank_impersonation: { minScore:1 },
  delivery_phishing: { minScore:1 },
  loan_scam: { minScore:1 },
  family_emergency: { minScore:1 },
  job_highpay_abroad: { anySig:["ctx_contact_move","ctx_visit_place"] },
};

function hasAny(arr, wants){
  const set=new Set((arr||[]).map(String));
  return (wants||[]).some(w=>set.has(w));
}

function pfCheck(key,obj){
  const r=pfReq[key]||{};
  const score=Number(obj?.score||0);
  const gate=!!obj?.gatePass;
  const trig=obj?.trig||obj?.trigIds||[];
  const okScore = (r.minScore==null) ? true : score>=r.minScore;
  const okTrig  = (r.anyTrig==null) ? true : hasAny(trig,r.anyTrig);
  const ok = gate && okScore && okTrig;
  return { ok, score, gatePass:gate, trig };
}

function fullCheck(key,obj){
  const r=fullReq[key]||{};
  const score=Number(obj?.scoreTotal||0);
  const sig=obj?.signalsTop||[];
  const okScore = (r.minScore==null) ? true : score>=r.minScore;
  const okSig   = (r.anySig==null) ? true : hasAny(sig,r.anySig);
  const ok = okScore && okSig;
  return { ok, scoreTotal:score, risk:obj?.risk, triggered:!!obj?.triggered, signalsTop:sig };
}

const pfMap=Object.fromEntries(pf.map(x=>[x.key,x.obj]));
const fullMap=Object.fromEntries(full.map(x=>[x.key,x.obj]));
const keys=[...new Set([...Object.keys(pfMap),...Object.keys(fullMap)])].sort();

const fails=[];
for(const k of keys){
  const pfRes=pfCheck(k,pfMap[k]||{});
  const fullRes=fullCheck(k,fullMap[k]||{});
  if(!pfRes.ok || !fullRes.ok){
    fails.push({ k, pf:pfRes, full:fullRes });
  }
}

console.log(JSON.stringify({
  files:{ full:fullPath, pf:pfPath },
  total: keys.length,
  failCount: fails.length,
  fails
}, null, 2));
