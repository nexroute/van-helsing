import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// VanHelsing ships behind OpenZeppelin's TransparentUpgradeableProxy: integrators and the node
// call the proxy's address permanently, and `owner`, the team's Safe, swaps the code behind it
// through the ProxyAdmin the proxy deploys. Upgrades take effect at once, with no timelock. The
// Safe owns the registry too, whose `operator`, the node's key, writes its storage.
export default buildModule("VanHelsing", (m) => {
    const beneficiary = m.getParameter("beneficiary");
    const owner = m.getParameter("owner");
    const operator = m.getParameter("operator");

    // The registry starts empty: its operator writes the pools and per-token policies.
    const registry = m.contract("PoolRegistry", []);
    // External linked libraries, deployed separately so their bytecode does not count
    // against VanHelsing's 24576-byte limit: CurveLib (stableswap legs), the two singleton
    // execution adapters (UniV4Lib, InfinityLib), RouteLib (2-hop route composition), and
    // the two per-tick depth walks (V3Depth, V4Depth). RouteLib itself calls into V3Depth
    // and V4Depth, so those two are linked into RouteLib's own deployment too.
    const v3Depth = m.library("V3Depth");
    const v4Depth = m.library("V4Depth");
    const libraries = {
        CurveLib: m.library("CurveLib"),
        UniV4Lib: m.library("UniV4Lib"),
        InfinityLib: m.library("InfinityLib"),
        RouteLib: m.library("RouteLib", { libraries: { V3Depth: v3Depth, V4Depth: v4Depth } }),
        V3Depth: v3Depth,
        V4Depth: v4Depth,
    };
    const implementation = m.contract("VanHelsing", [registry, beneficiary], { libraries, id: "VanHelsingImplementation" });

    // OpenZeppelin's proxy refuses empty init data. VanHelsing keeps no state to initialize, so the
    // init call is a read of REGISTRY(), which changes nothing (lib/contract.js proxyInit).
    const init = m.encodeFunctionCall(implementation, "REGISTRY", []);
    // The proxy alone comes from the second account, the vanity key, as its first transaction: a
    // contract's address follows from its sender and that sender's nonce, so the proxy lands at the
    // address the key was drawn for. The first account sends everything else.
    const proxy = m.contract("TransparentUpgradeableProxy", [implementation, owner, init], { from: m.getAccount(1) });
    const proxyAdmin = m.contractAt("ProxyAdmin", m.readEventArgument(proxy, "AdminChanged", "newAdmin"));
    const vanHelsing = m.contractAt("VanHelsing", proxy, { id: "VanHelsingProxy" });

    // The deployer, still the registry's owner, appoints its operator, then hands ownership to
    // the Safe and keeps no role.
    const appoint = m.call(registry, "setOperator", [operator], { id: "AppointOperator" });
    m.call(registry, "transferOwnership", [owner], { id: "HandRegistryToOwner", after: [appoint] });

    return { registry, implementation, proxy, proxyAdmin, vanHelsing };
});
