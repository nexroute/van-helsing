import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// A new implementation for the proxy VanHelsing (VanHelsing.js) deployed: the libraries it links
// and the implementation, built for the same registry and treasury. The proxy changes only when its
// ProxyAdmin's owner, the Safe, calls upgradeAndCall (scripts/upgrade.mjs prints that call).
export default buildModule("VanHelsingUpgrade", (m) => {
    const registry = m.getParameter("registry");
    const beneficiary = m.getParameter("beneficiary");
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
    return { implementation };
});
