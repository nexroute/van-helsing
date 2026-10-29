// The upgrade of Van Helsing's implementation behind its proxy on BNB Chain: the libraries and the
// implementation deployed with Ignition (ignition/modules/VanHelsingUpgrade.js) for the registry and
// treasury the proxy holds, checked, and the transaction the ProxyAdmin's owner, the Safe, sends.
// scripts/upgrade.mjs runs it on BNB Chain; test/upgrade-fork.test.js on a fork, the Safe
// impersonated.
import VanHelsingUpgradeModule from "../ignition/modules/VanHelsingUpgrade.js";

export const PROXY = "0xbE5AFE00a6dB1F9c8Dc83B0767441dAE60404F25";
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // ERC-1967
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"; // ERC-1967
const MAX_CODE = 24_576;

const slotAddress = (ethers, word) => ethers.getAddress("0x" + word.slice(26));

// What the proxy holds now: its implementation, its ProxyAdmin and that one's owner, and the
// registry, treasury and cut its code was built with.
export async function proxyState(conn) {
    const { ethers } = conn;
    const vh = await ethers.getContractAt("VanHelsing", PROXY);
    const admin = slotAddress(ethers, await ethers.provider.getStorage(PROXY, ADMIN_SLOT));
    return {
        implementation: slotAddress(ethers, await ethers.provider.getStorage(PROXY, IMPL_SLOT)),
        admin,
        owner: await (await ethers.getContractAt("ProxyAdmin", admin)).owner(),
        registry: await vh.REGISTRY(),
        treasury: await vh.TREASURY(),
        cut: await vh.CUT_BPS(),
    };
}

// Deploys the new implementation and its libraries, checks them, and returns the Safe's call:
// ProxyAdmin.upgradeAndCall(proxy, implementation, 0x).
export async function prepareUpgrade(conn, { deploymentId, displayUi = false } = {}) {
    const { ethers, ignition } = conn;
    const before = await proxyState(conn);
    const { implementation } = await ignition.deploy(VanHelsingUpgradeModule, {
        parameters: { VanHelsingUpgrade: { registry: before.registry, beneficiary: before.treasury } },
        deploymentId,
        displayUi,
    });
    const impl = await implementation.getAddress();
    const code = await ethers.provider.getCode(impl);
    const checks = [
        ["the implementation is new", impl !== before.implementation],
        [`its code fits ${MAX_CODE} bytes`, code.length > 2 && (code.length - 2) / 2 <= MAX_CODE],
        ["it is built for the proxy's registry", (await implementation.REGISTRY()) === before.registry],
        ["and its treasury", (await implementation.TREASURY()) === before.treasury],
        ["with the same cut", (await implementation.CUT_BPS()) === before.cut],
    ];
    const admin = await ethers.getContractAt("ProxyAdmin", before.admin);
    const data = admin.interface.encodeFunctionData("upgradeAndCall", [PROXY, impl, "0x"]);
    return { before, impl, codeBytes: (code.length - 2) / 2, checks, tx: { to: before.admin, value: "0", data } };
}

// After the Safe's call: the proxy runs the new implementation with the same registry, treasury
// and cut.
export async function checkUpgraded(conn, prepared) {
    const { ethers } = conn;
    const after = await proxyState(conn);
    return [
        ["the proxy's implementation slot names it", after.implementation === prepared.impl],
        ["REGISTRY() is the same", after.registry === prepared.before.registry],
        ["TREASURY() is the same", after.treasury === prepared.before.treasury],
        ["CUT_BPS() is the same", after.cut === prepared.before.cut],
        ["the ProxyAdmin and its owner are the same", after.admin === prepared.before.admin && after.owner === prepared.before.owner],
    ].concat(await ethers.provider.getCode(PROXY) === "0x" ? [["the proxy has code", false]] : []);
}

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const V2_USDT_WBNB = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // PancakeSwap V2, listed with an anchor
const idAddr = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

// PancakeSwap V2 USDT/WBNB skewed by 300 WBNB, then warded through the proxy until a ward captures
// nothing (a ward sized short of the meeting price leaves the rest to the next): each ward's bounty
// and gas, and what execute, which ward runs, says once they stop. A ward never reverts, so only
// execute shows how the last one failed.
async function skewAndWard(conn) {
    const { ethers } = conn;
    const [me] = await ethers.getSigners();
    const wbnb = new ethers.Contract(WBNB, ["function deposit() payable", "function transfer(address,uint256) returns (bool)"], me);
    await (await wbnb.deposit({ value: 300n * 10n ** 18n })).wait();
    await (await wbnb.transfer(V2_USDT_WBNB, 300n * 10n ** 18n)).wait();
    await (await new ethers.Contract(V2_USDT_WBNB, ["function sync()"], me).sync()).wait();
    const vh = await ethers.getContractAt("VanHelsing", PROXY);
    const wards = [];
    for (let i = 0; i < 6 && (wards.length === 0 || wards.at(-1).bounty !== undefined); i++) {
        const rc = await (await vh["ward(bytes32,address)"](idAddr(V2_USDT_WBNB), me.address, { gasLimit: 5_000_000 })).wait();
        const ev = rc.logs.map((l) => { try { return vh.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Captured");
        wards.push({ ok: rc.status === 1, bounty: ev?.args.bounty, gas: rc.gasUsed });
    }
    const end = await vh.execute.staticCall(idAddr(V2_USDT_WBNB), me.address).then(() => "captures", (e) => {
        const data = [e.data, e.info?.error?.data, e.error?.data].find((d) => typeof d === "string" && d.startsWith("0x"));
        if (data?.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
        return data ?? e.message.match(/return data: (0x[0-9a-f]*)/)?.[1] ?? e.message;
    });
    return { wards, end };
}

// On a fork, from one state: the wards through the proxy as deployed; then, the state put back,
// the Safe, impersonated, sends the call, the proxy is checked, and the same wards through the
// upgraded proxy must capture what the deployed contract's do, to the wei, and end as they do.
// (On a skewed USDT/WBNB pair, both end on a restore of a few wei that the pools' rounding fails,
// TransferFailed() on both.)
export async function upgradeOnFork(conn, prepared) {
    const { ethers, networkHelpers } = conn;
    const snapshot = await networkHelpers.takeSnapshot();
    const deployed = await skewAndWard(conn);
    await snapshot.restore();
    const owner = prepared.before.owner;
    await networkHelpers.impersonateAccount(owner);
    await networkHelpers.setBalance(owner, 10n ** 18n);
    await (await (await ethers.getSigner(owner)).sendTransaction(prepared.tx)).wait();
    const checks = await checkUpgraded(conn, prepared);
    const upgraded = await skewAndWard(conn);
    const bounties = (r) => r.wards.map((w) => w.bounty ?? "nothing").join(", ");
    checks.push(["a ward on the skewed pair captures", upgraded.wards[0].ok && upgraded.wards[0].bounty > 0n]);
    checks.push([`its wards capture what the deployed contract's do, to the wei (${bounties(upgraded)})`, bounties(upgraded) === bounties(deployed) && upgraded.wards.every((w) => w.ok)]);
    checks.push([`and end as the deployed contract's do (execute: ${upgraded.end}; deployed: ${deployed.end})`, upgraded.end === deployed.end]);
    return { checks, skewed: upgraded.wards[0], after: upgraded.wards.slice(1), deployed };
}
