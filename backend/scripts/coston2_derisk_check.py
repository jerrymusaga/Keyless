#!/usr/bin/env python3
"""
coston2_derisk_check.py

Five decisive reads against live Coston2. Read-only. No key needed.

    pip install web3
    python coston2_derisk_check.py

Each check prints GO / NO-GO / UNKNOWN and why.
Addresses below come from:
  - flare-foundation/fce-sign  @ config/coston2/deployed-addresses.json
  - FlareContractRegistry (same address on every Flare network)
"""

import sys
from web3 import Web3

RPC = "https://coston2-api.flare.network/ext/C/rpc"

REGISTRY = Web3.to_checksum_address("0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019")
FLARE_TEE_MANAGER = Web3.to_checksum_address("0x004224fa1BF1Acd3D233f011FB03b8dd5fA5d41F")
TEE_PAYMENTS_FXRP = Web3.to_checksum_address("0xD02384dcbA8bBb42E4E8b417b8542410AE0CF484")
TEE_PAYMENTS_REGISTRY = Web3.to_checksum_address("0xBEc5C38D5354CEd864b7B736159FaAF722CFAcA7")

ABI_REGISTRY = [{
    "name": "getContractAddressByName", "type": "function", "stateMutability": "view",
    "inputs": [{"type": "string", "name": "_name"}],
    "outputs": [{"type": "address", "name": ""}],
}]

ABI_WHITELIST = [
    {"name": "allowAll", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bool", "name": ""}]},
    {"name": "manager", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address", "name": ""}]},
    {"name": "isWhitelisted", "type": "function", "stateMutability": "view",
     "inputs": [{"type": "address", "name": "_address"}],
     "outputs": [{"type": "bool", "name": ""}]},
]

ABI_TEE_PAYMENTS = [
    {"name": "paymentModel", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint8", "name": ""}]},
    {"name": "teePaymentsRegistry", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address", "name": ""}]},
    {"name": "flareTeeManager", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address", "name": ""}]},
]

ABI_TEE_PAY_REGISTRY = [
    {"name": "getRegisteredSourceIds", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bytes32[]", "name": ""}]},
    {"name": "getRegisteredTeePaymentsContracts", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "address[]", "name": ""}]},
]


def verdict(label, status, detail):
    tag = {"GO": "\033[92mGO    \033[0m",
           "NO-GO": "\033[91mNO-GO \033[0m",
           "UNKNOWN": "\033[93mUNKNWN\033[0m"}[status]
    print(f"[{tag}] {label}\n         {detail}\n")


def has_code(w3, addr):
    return w3.eth.get_code(addr) not in (b"", b"0x", None)


def main():
    w3 = Web3(Web3.HTTPProvider(RPC))
    if not w3.is_connected():
        sys.exit("cannot reach Coston2 RPC")
    print(f"connected — block {w3.eth.block_number}\n")

    # ---- CHECK 1: is PMW actually deployed, and is there an XRP instance?
    tee_live = has_code(w3, FLARE_TEE_MANAGER)
    pmw_live = has_code(w3, TEE_PAYMENTS_FXRP)
    if tee_live and pmw_live:
        verdict("1. PMW deployed on Coston2", "GO",
                f"FlareTeeManager + TeePayments_F_XRP both have bytecode.")
    else:
        verdict("1. PMW deployed on Coston2", "NO-GO",
                f"FlareTeeManager={tee_live} TeePayments_F_XRP={pmw_live}. "
                "Addresses may be stale — re-pull fce-sign config.")

    # ---- CHECK 2: which payment sources are registered (is XRP wired up?)
    try:
        reg = w3.eth.contract(address=TEE_PAYMENTS_REGISTRY, abi=ABI_TEE_PAY_REGISTRY)
        sources = reg.functions.getRegisteredSourceIds().call()
        decoded = [s.rstrip(b"\x00").decode(errors="replace") for s in sources]
        contracts = reg.functions.getRegisteredTeePaymentsContracts().call()
        if decoded:
            verdict("2. Registered PMW payment sources", "GO",
                    f"sources={decoded}  contracts={len(contracts)}")
        else:
            verdict("2. Registered PMW payment sources", "NO-GO",
                    "No sources registered — PMW is deployed but inert.")
    except Exception as e:
        verdict("2. Registered PMW payment sources", "UNKNOWN", f"{type(e).__name__}: {e}")

    # ---- CHECK 3: PMW payment model + wiring
    try:
        tp = w3.eth.contract(address=TEE_PAYMENTS_FXRP, abi=ABI_TEE_PAYMENTS)
        model = tp.functions.paymentModel().call()
        mgr = tp.functions.flareTeeManager().call()
        verdict("3. TeePayments_F_XRP wiring", "GO",
                f"paymentModel={model} (0=account-based/XRPL, 1=UTXO expected)  "
                f"flareTeeManager={mgr}")
    except Exception as e:
        verdict("3. TeePayments_F_XRP wiring", "UNKNOWN", f"{type(e).__name__}: {e}")

    # ---- CHECK 4: THE AGENT GATE. Is the whitelist open on testnet?
    try:
        r = w3.eth.contract(address=REGISTRY, abi=ABI_REGISTRY)
        aor = r.functions.getContractAddressByName("AgentOwnerRegistry").call()
        if int(aor, 16) == 0:
            verdict("4. Agent whitelist", "UNKNOWN",
                    "AgentOwnerRegistry not in FlareContractRegistry under that name. "
                    "Try 'AgentOwnerRegistry_FXRP' or read it from the AssetManager.")
        else:
            wl = w3.eth.contract(address=aor, abi=ABI_WHITELIST)
            allow_all = wl.functions.allowAll().call()
            manager = wl.functions.manager().call()
            if allow_all:
                verdict("4. Agent whitelist", "GO",
                        f"AgentOwnerRegistry={aor}  allowAll=TRUE. "
                        "Anyone can be an agent on Coston2. The gate is open.")
            else:
                verdict("4. Agent whitelist", "NO-GO",
                        f"AgentOwnerRegistry={aor}  allowAll=FALSE  manager={manager}. "
                        "You must be whitelisted by governance or that manager. Email them.")
    except Exception as e:
        verdict("4. Agent whitelist", "UNKNOWN", f"{type(e).__name__}: {e}")

    # ---- CHECK 5: the deadline you're racing
    try:
        r = w3.eth.contract(address=REGISTRY, abi=ABI_REGISTRY)
        am = r.functions.getContractAddressByName("AssetManagerFXRP").call()
        if int(am, 16) == 0:
            am = r.functions.getContractAddressByName("AssetManagerFTestXRP").call()
        abi_am = [{"name": "getSettings", "type": "function", "stateMutability": "view",
                   "inputs": [], "outputs": [{"type": "tuple", "name": "", "components": [
                       {"type": "uint256", "name": "_"}]}]}]
        print(f"         AssetManager candidate: {am}")
        verdict("5. Redemption payment window", "UNKNOWN",
                "getSettings() returns a large struct — decode with the real ABI from "
                "flare-labs-ltd/fassets and read underlyingSecondsForPayment / "
                "underlyingBlocksForPayment. That is the deadline PMW must beat.")
    except Exception as e:
        verdict("5. Redemption payment window", "UNKNOWN", f"{type(e).__name__}: {e}")

    print("Decision rule:")
    print("  1,2,3 GO  -> build on PMW. No enclave code. No code-hash governance problem.")
    print("  1,2,3 fail -> fall back to a custom FCE that signs XRPL itself (harder).")
    print("  4 GO      -> you can register a real agent. Full product in reach.")
    print("  4 NO-GO   -> ship the mechanism demo, skip agent registration.")


if __name__ == "__main__":
    main()
