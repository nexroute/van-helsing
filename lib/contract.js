// HH3: ethers + networkHelpers are connection-scoped, so the caller passes the
// connection (`const conn = await network.connect(...)`).
//
// VanHelsing ships behind OpenZeppelin's TransparentUpgradeableProxy. `proxy: true` deploys it
// that way, the proxy's ProxyAdmin owned by the first signer, and returns VanHelsing at the
// proxy's address; VH_PROXY=1 makes it the default, so the whole suite runs through the proxy
// (`VH_PROXY=1 npx hardhat test`). `proxy: false` always deploys the contract alone.
const deploy = async (conn, name, address, args, opts) => {
    const { ethers, networkHelpers } = conn;
    args = args ?? [];
    const { libraries: libMap, proxy = name === "VanHelsing" && process.env.VH_PROXY === "1", ...restOpts } = opts ?? {};

    // Deploy and link libraries. A library can itself need other libraries linked in
    // (e.g. RouteLib calls V3Depth/V4Depth), and the top-level contract may need only
    // a subset of everything listed here (e.g. RouteLibHarness calls RouteLib, not
    // V3Depth/V4Depth directly). getFactory tries unlinked first, and on a missing-link
    // error links exactly the libraries Hardhat names, so it never over-specifies: they are
    // pulled from the siblings this loop already resolved (list a dependency before its
    // dependent in the caller's `libraries` map).
    const libraries = { ...libMap };
    for (const [libName, libAddress] of Object.entries(libraries)) {
        if (libAddress == null) {
            const Library = await getFactory(ethers, libName, libraries);
            libraries[libName] = await (await Library.deploy()).getAddress();
        }
    }

    // deploy contract
    const Contract = await getFactory(ethers, name, libraries, restOpts);
    let contract = await Contract.deploy(...args);
    if (proxy) {
        if (address != null) throw new Error(`${name}: a proxied deploy takes no fixed address`);
        const [owner] = await ethers.getSigners();
        const Proxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
        const proxied = await Proxy.deploy(await contract.getAddress(), owner.address, proxyInit(Contract));
        return Contract.attach(await proxied.getAddress());
    }
    if (address != null) {
        await networkHelpers.setCode(address, await contract.getDeployedCode());
        contract = Contract.attach(address);
    }
    return contract;
};

// The proxy's init call. VanHelsing keeps no state to initialize, but OpenZeppelin's proxy refuses
// empty init data (since 5.6, against a front-run of an uninitialized proxy): a read of REGISTRY()
// changes nothing and checks the code behind the proxy answers as VanHelsing does.
const proxyInit = (Contract) => Contract.interface.encodeFunctionData("REGISTRY");

// Get a contract factory, linking libraries only if needed. Tries unlinked first (the
// common case); if Hardhat reports specific missing links (HHE20012), retry with
// exactly those, taken from `resolved` (the libraries deployed so far, by name). Falls
// through to the original error if a needed name is not in `resolved` either (a caller
// bug: the library was never declared in the `libraries` map at all).
const getFactory = async (ethers, name, resolved, extraOpts) => {
    try {
        return await ethers.getContractFactory(name, extraOpts);
    } catch (err) {
        if (err?.number !== 20012) throw err; // not a missing-link error
        const needed = err.messageArguments.missingLibraries
            .split("\n")
            .map((line) => line.trim().replace(/^\* /, "").split(":").pop());
        const subLibraries = {};
        for (const n of needed) subLibraries[n] = resolved[n];
        if (Object.values(subLibraries).some((a) => a == null)) throw err;
        return ethers.getContractFactory(name, { ...extraOpts, libraries: subLibraries });
    }
};

export { deploy, proxyInit };
