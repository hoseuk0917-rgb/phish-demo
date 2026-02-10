import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const ds = process.argv[2];
const id = process.argv[3];

const line = fs.readFileSync(ds, "utf8").split(/\r?\n/).find(l => l.includes(id));
if (!line) throw new Error("not found");

const row:any = JSON.parse(line);
const res:any = analyzeThread({ threadText: String(row.thread ?? ""), callChecks: { otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) } } as any);

console.log("riskLevel=", res.riskLevel);
console.log("uiRiskLevel=", res.uiRiskLevel);
console.log("keys=", Object.keys(res).sort());
