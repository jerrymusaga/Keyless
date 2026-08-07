// Waits for Firelight period 84 to end, then claims the pending 10 FXRP exit and verifies it landed.
// This is the one unverified link in the vault-exit flow: the claim instruction encoding (0x13 + period).
import { createPublicClient, createWalletClient, http, defineChain, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync("../backend/.env","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).trim()]));
const RPC="https://coston2-api.flare.network/ext/C/rpc";
const c2=defineChain({id:114,name:"Coston2",nativeCurrency:{name:"C2FLR",symbol:"C2FLR",decimals:18},rpcUrls:{default:{http:[RPC]}}});
const pc=createPublicClient({chain:c2,transport:http(RPC)});
const acct=privateKeyToAccount(env.PK.startsWith("0x")?env.PK:`0x${env.PK}`);
const wc=createWalletClient({account:acct,chain:c2,transport:http(RPC)});

const ACCOUNTS="0x57eb332D7000752ee82a35cc1A75941F0a619979";
const FSA="0x434936d47503353f06750Db1A444DBDC5F0AD37c";
const VAULT="0xC90D6847747b85d1fa2E07859869fb9fB72c0361";
const FSA_WALLET="rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
const WID=fs.readFileSync("/tmp/mint_wid","utf8").trim();
const PA=fs.readFileSync("/tmp/mint_pa","utf8").trim();
const PERIOD=84n, VAULT_ID=1n;

const V_ABI=[{type:"function",name:"currentPeriod",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},
 {type:"function",name:"withdrawalsOf",stateMutability:"view",inputs:[{type:"uint256"},{type:"address"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"isWithdrawClaimed",stateMutability:"view",inputs:[{type:"uint256"},{type:"address"}],outputs:[{type:"bool"}]}];
const PAY=[{type:"function",name:"pay",stateMutability:"payable",inputs:[{type:"bytes32"},{type:"string"},{type:"uint256"},{type:"bytes32"}],outputs:[{type:"bytes32"}]}];
const R_ABI=[{type:"function",name:"getBalances",stateMutability:"view",inputs:[{name:"account",type:"address"}],outputs:[{type:"tuple",components:[
 {name:"natBalance",type:"uint256"},{name:"wNat",type:"tuple",components:[{name:"token",type:"address"},{name:"balance",type:"uint256"}]},
 {name:"fXrp",type:"tuple",components:[{name:"token",type:"address"},{name:"balance",type:"uint256"}]},
 {name:"vaults",type:"tuple[]",components:[{name:"vaultId",type:"uint256"},{name:"vaultAddress",type:"address"},{name:"vaultType",type:"uint8"},{name:"shares",type:"uint256"},{name:"assets",type:"uint256"}]}]}]}];

const log=(m)=>{const l=`[${new Date().toISOString().slice(11,19)}Z] ${m}`;console.log(l);fs.appendFileSync("/tmp/claim.log",l+"\n");};
const liquid=async()=>(await pc.readContract({address:FSA,abi:R_ABI,functionName:"getBalances",args:[PA]})).fXrp.balance;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

log(`waiting for Firelight period ${PERIOD} to end…`);
for(;;){
  const cur=await pc.readContract({address:VAULT,abi:V_ABI,functionName:"currentPeriod"}).catch(()=>null);
  if(cur!==null && cur>PERIOD){ log(`period ${PERIOD} has ended (current ${cur}) — claiming`); break; }
  await sleep(300000);
}

const before=await liquid();
const owed=await pc.readContract({address:VAULT,abi:V_ABI,functionName:"withdrawalsOf",args:[PERIOD,PA]});
log(`liquid before: ${Number(before)/1e6} FXRP | owed for period ${PERIOD}: ${Number(owed)/1e6} FXRP`);

// The encoding under test: instruction 0x13 (Firelight claim), the PERIOD as the value.
const ref=toHex((0x13n<<248n)|(PERIOD<<160n)|(VAULT_ID<<128n),{size:32});
log(`claim reference: ${ref}`);
try{
  const h=await wc.writeContract({address:ACCOUNTS,abi:PAY,functionName:"pay",args:[WID,FSA_WALLET,100000n,ref],value:1000n});
  await pc.waitForTransactionReceipt({hash:h});
  log(`claim instruction sent: ${h}`);
}catch(e){ log(`FAILED to send: ${e.shortMessage||e.message}`); process.exit(1); }

for(let i=0;i<70;i++){
  await sleep(15000);
  const now=await liquid().catch(()=>before);
  if(now>before){
    const claimed=await pc.readContract({address:VAULT,abi:V_ABI,functionName:"isWithdrawClaimed",args:[PERIOD,PA]}).catch(()=>null);
    log(`*** CLAIM WORKED — liquid ${Number(before)/1e6} -> ${Number(now)/1e6} FXRP (+${Number(now-before)/1e6}); isWithdrawClaimed=${claimed} ***`);
    log(`ENCODING CONFIRMED: 0x13 with the period in the value field.`);
    process.exit(0);
  }
}
log(`claim sent but nothing arrived after ~17 min — the 0x13 encoding is likely WRONG. Check /tmp/claim.log.`);
process.exit(2);
