import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr } from "./helpers/ids.js";
import VanHelsingModule from "../ignition/modules/VanHelsing.js";
import { describeFork } from "./helpers/fork.js";

// VanHelsing is deployed behind OpenZeppelin's TransparentUpgradeableProxy: integrators and
// the node call the proxy's address permanently, and the ProxyAdmin's owner swaps the code
// behind it to support new pools. The contract itself is unchanged, so a ward through the
// proxy must capture exactly what it captures alone.

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const V2_PANCAKE = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE"; // USDT/WBNB Pancake V2
const V2_BISWAP = "0x8840C6252e2e86e545deFb6da98B2a0E26d8C1BA"; // USDT/WBNB Biswap
const TREASURY = "0x00000000000000000000000000000000beC0ffEE";
const NEXT_TREASURY = "0x00000000000000000000000000000000000Ca5e2";
const PAYEE = "0x0000000000000000000000000000000000000B0b";
const V2_KIND = 0;
const ONE = 10n ** 18n;
const LIBS = { CurveLib: null, UniV4Lib: null, InfinityLib: null, V3Depth: null, V4Depth: null, RouteLib: null };
// ERC-1967: bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1), and the implementation's
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SAFE = "0x0000000000000000000000000000000000005afe";
const NODE = "0x000000000000000000000000000000000000c0de"; // the node's operator key

describeFork("VanHelsing behind its proxy", function () {
    let conn, ethers, networkHelpers;

    before(async function () {
        conn = await network.create({ network: "hardhat", override: { forking: { blockNumber: 67229517 } } });
        ethers = conn.ethers;
        networkHelpers = conn.networkHelpers;
    });

    // a front-run's footprint: WBNB dumped into the pair, synced
    async function skew(pair, amount) {
        const [whale] = await ethers.getSigners();
        const wbnb = await ethers.getContractAt("IWETH", WBNB);
        await networkHelpers.setBalance(whale.address, amount + 10n * ONE);
        await wbnb.connect(whale).deposit({ value: amount });
        await wbnb.connect(whale).transfer(pair, amount);
        await new ethers.Contract(pair, ["function sync() external"], whale).sync();
    }

    async function fixture() {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const args = [await registry.getAddress(), TREASURY];
        const alone = await deploy(conn, "VanHelsing", null, args, { libraries: LIBS, proxy: false });
        const proxied = await deploy(conn, "VanHelsing", null, args, { libraries: LIBS, proxy: true });
        await registry.setPools(USDT, WBNB, [
            [idAddr(V2_PANCAKE), V2_KIND, 25, 0],
            [idAddr(V2_BISWAP), V2_KIND, 20, 0],
        ]);
        return { registry, alone, proxied };
    }

    async function adminOf(proxy) {
        const word = await ethers.provider.getStorage(await proxy.getAddress(), ADMIN_SLOT);
        return ethers.getContractAt("ProxyAdmin", ethers.getAddress("0x" + word.slice(26)));
    }

    it("a ward through the proxy captures exactly what the contract alone does, and the proxy logs it", async function () {
        const { alone, proxied } = await networkHelpers.loadFixture(fixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        await skew(V2_PANCAKE, 300n * ONE);
        const before = await networkHelpers.takeSnapshot();

        const paid = async (vh) => {
            const t0 = await usdt.balanceOf(PAYEE), c0 = await usdt.balanceOf(TREASURY);
            const rc = await (await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 })).wait();
            return { rc, to: (await usdt.balanceOf(PAYEE)) - t0, cut: (await usdt.balanceOf(TREASURY)) - c0 };
        };
        const a = await paid(alone);
        await before.restore();
        const p = await paid(proxied);

        expect(a.to).to.be.gt(0n);
        expect(p.to).to.equal(a.to);
        expect(p.cut).to.equal(a.cut);
        const logged = p.rc.logs.find((log) => {
            try { return proxied.interface.parseLog(log)?.name === "Captured"; } catch { return false; }
        });
        expect(logged.address).to.equal(await proxied.getAddress());
        const extra = p.rc.gasUsed - a.rc.gasUsed;
        console.log(`      a capturing ward: ${a.rc.gasUsed} gas alone, ${p.rc.gasUsed} through the proxy (+${extra})`);
        expect(extra).to.be.gt(0n);
        expect(extra).to.be.lt(10_000n);
    });

    it("a ward with nothing to capture costs a few thousand gas more through the proxy, and does nothing", async function () {
        const { alone, proxied } = await networkHelpers.loadFixture(fixture);
        const usdt = await ethers.getContractAt("IERC20", USDT);
        const a = await (await alone["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 })).wait();
        const t0 = await usdt.balanceOf(PAYEE);
        const p = await (await proxied["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 })).wait();
        expect(await usdt.balanceOf(PAYEE)).to.equal(t0);
        expect(p.logs.filter((log) => log.address === p.to)).to.have.length(0);
        const extra = p.gasUsed - a.gasUsed;
        console.log(`      a ward with nothing to capture: ${a.gasUsed} gas alone, ${p.gasUsed} through the proxy (+${extra})`);
        expect(extra).to.be.gt(0n);
        expect(extra).to.be.lt(10_000n);
    });

    // A ward reads its pair's list only as far as its anchor, the first pool listed other than
    // itself: three more pools listed behind them cost it next to nothing.
    it("a ward reads its pair's list only as far as its anchor", async function () {
        const registry = await deploy(conn, "PoolRegistryHarness");
        const vh = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), TREASURY], { libraries: LIBS, proxy: false });
        const two = [[idAddr(V2_PANCAKE), V2_KIND, 25, 0], [idAddr(V2_BISWAP), V2_KIND, 20, 0]];
        const more = [1, 2, 3].map((n) => [idAddr("0x" + n.toString(16).padStart(40, "0")), V2_KIND, 25, 0]);
        const gas = {};
        for (const [what, list] of [["two", two], ["five", [...two, ...more]]]) {
            await registry.setPools(USDT, WBNB, list);
            const tx = await vh["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 });
            gas[what] = (await tx.wait()).gasUsed;
        }
        console.log(`      a ward with nothing to capture: ${gas.two} gas with two pools listed, ${gas.five} with five`);
        expect(gas.five - gas.two).to.be.lt(1_000n);
    });

    it("only the ProxyAdmin's owner swaps the code, and the address goes on warding with it", async function () {
        const { registry, proxied } = await networkHelpers.loadFixture(fixture);
        const [owner, stranger] = await ethers.getSigners();
        const admin = await adminOf(proxied);
        expect(await admin.owner()).to.equal(owner.address);

        const next = await deploy(conn, "VanHelsing", null, [await registry.getAddress(), NEXT_TREASURY], { libraries: LIBS, proxy: false });
        await expect(admin.connect(stranger).upgradeAndCall(await proxied.getAddress(), await next.getAddress(), "0x"))
            .to.be.revertedWithCustomError(admin, "OwnableUnauthorizedAccount");
        expect(await proxied.TREASURY()).to.equal(TREASURY);

        await admin.upgradeAndCall(await proxied.getAddress(), await next.getAddress(), "0x");
        expect(await proxied.TREASURY()).to.equal(NEXT_TREASURY);

        const usdt = await ethers.getContractAt("IERC20", USDT);
        await skew(V2_PANCAKE, 300n * ONE);
        const cut0 = await usdt.balanceOf(NEXT_TREASURY);
        await proxied["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 });
        expect(await usdt.balanceOf(NEXT_TREASURY)).to.be.gt(cut0);
    });

    it("the proxy never answers its admin's other calls, so a ward cannot come from the admin", async function () {
        const { proxied } = await networkHelpers.loadFixture(fixture);
        const admin = await adminOf(proxied);
        const adminAddr = await admin.getAddress();
        await networkHelpers.impersonateAccount(adminAddr);
        await networkHelpers.setBalance(adminAddr, ONE);
        const asAdmin = await ethers.getSigner(adminAddr);
        // the proxy's handle first: awaited after the call is sent, its rejection would go unhandled for a moment
        const proxy = await ethers.getContractAt("TransparentUpgradeableProxy", await proxied.getAddress());
        await expect(proxied.connect(asAdmin)["ward(bytes32,address)"](idAddr(V2_PANCAKE), PAYEE, { gasLimit: 3_000_000 }))
            .to.be.revertedWithCustomError(proxy, "ProxyDeniedAdminAccess");
    });

    it("the deploy module puts VanHelsing behind the proxy, and hands the Safe it names the upgrades and the registry", async function () {
        // The proxy alone comes from the second account, on mainnet the vanity key: as that key's
        // first transaction, it lands at the address the key was drawn for.
        const [deployer, vanity] = await ethers.getSigners();
        const nonce = await ethers.provider.getTransactionCount(vanity.address);
        const { vanHelsing, implementation, proxyAdmin, registry } = await conn.ignition.deploy(VanHelsingModule, {
            parameters: { VanHelsing: { beneficiary: TREASURY, owner: SAFE, operator: NODE } },
        });
        const at = await vanHelsing.getAddress();
        expect(at).to.equal(ethers.getCreateAddress({ from: vanity.address, nonce }));
        expect(await ethers.provider.getTransactionCount(vanity.address)).to.equal(nonce + 1);
        // the deployer appoints the node's key, then hands the registry to the Safe: it keeps nothing
        expect(await registry.operator()).to.equal(ethers.getAddress(NODE));
        expect(await registry.owner()).to.equal(ethers.getAddress(SAFE));
        expect(await registry.owner()).to.not.equal(deployer.address);
        expect(at).to.not.equal(await implementation.getAddress());
        const slot = await ethers.provider.getStorage(at, IMPLEMENTATION_SLOT);
        expect(ethers.getAddress("0x" + slot.slice(26))).to.equal(await implementation.getAddress());
        expect(await proxyAdmin.owner()).to.equal(ethers.getAddress(SAFE));
        expect(await vanHelsing.REGISTRY()).to.equal(await registry.getAddress());
        expect(await vanHelsing.TREASURY()).to.equal(TREASURY);
    });
});

