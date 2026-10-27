import { network } from "hardhat";
import { expect } from "chai";
import { deploy } from "../lib/contract.js";
import { idAddr, idRoute, configRoute, ROUTE } from "./helpers/ids.js";

const ONE = 10n ** 18n;
const Q96 = 2n ** 96n;

// integer sqrt (bigint), same as route-compose.test.js
function isqrt(n) {
    if (n < 0n) throw new Error("neg");
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
}

// RouteLib._hopVR picks a concentrated hop's walk direction with
//   toMax = (near == tok0) ? up : !up
// (RouteLib.sol, the V3 branch and the V4/Infinity branch, same ternary). The
// `near == tok0` arm is exercised by route-fork.test.js's V4 hop (USDT/WBNB), where
// near(USDT) == tok0: a rule keyed on the pair side instead, `hop1 ? up : !up`,
// would flip hop2's direction there. No other test reaches the `near == tok1` arm:
// route-v2.test.js is pure V2 (no walk at all), and route-fork.test.js's V3 hop
// (X/USDT) also lands near == tok0. The pair-side rule on a near==tok1 hop would
// silently mis-size the restore (funds-safe, but a defense hole) with nothing to
// catch it. This test covers that arm directly against RouteLib (not V3Depth in
// isolation), so it also pins the near/tok0/tok1 wiring itself.
describe("RouteLib.effectiveLiquidity (near == tok1 walk direction)", function () {
    let conn, ethers, me, registry, harness;

    before(async function () {
        conn = await network.create({ network: "hardhat" });
        ethers = conn.ethers;
        [me] = await ethers.getSigners();
        registry = await deploy(conn, "PoolRegistryHarness");
        harness = await deploy(conn, "RouteLibHarness", null, [], { libraries: { V3Depth: null, V4Depth: null, RouteLib: null } });
    });

    async function mkToken(sym) { return deploy(conn, "MockERC20", null, ["Mock " + sym, sym]); }

    it("walks the near==tok1 hop toward MIN when up, toward MAX when !up (not the pair-side hop1?up:!up rule)", async function () {
        // Deploy three tokens and sort them by address (lowercase-hex compare). The
        // smallest becomes the bridge B; the other two, sorted, become the defended
        // pair's (t0Tok, t1Tok). This pins B < t0Tok < t1Tok, so hop1, which
        // RouteLib always connects as (t0Tok, B) with near=t0Tok, sorts in the
        // POOL's own order as (tok0=B, tok1=t0Tok): near(t0Tok) == tok1, the branch
        // no other test reaches.
        const deployed = await Promise.all([mkToken("M"), mkToken("N"), mkToken("O")]);
        const sorted = (
            await Promise.all(deployed.map(async (t) => ({ t, a: (await t.getAddress()).toLowerCase() })))
        ).sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
        const B = sorted[0].t, t0Tok = sorted[1].t, t1Tok = sorted[2].t;
        const bAddr = await B.getAddress(), t0Addr = await t0Tok.getAddress(), t1Addr = await t1Tok.getAddress();
        expect(bAddr.toLowerCase() < t0Addr.toLowerCase()).to.equal(true);
        expect(t0Addr.toLowerCase() < t1Addr.toLowerCase()).to.equal(true);

        // hop1: V3-kind pool on (B, t0Tok). Since bAddr < t0Addr, the pool's own sort
        // is token0=B, token1=t0Tok, so RouteLib's near=t0Tok is tok1.
        // Liquidity is ASYMMETRIC around the active tick: deep sits one tick ABOVE
        // (toward MAX_SQRT), nothing is configured below (toward MIN_SQRT), so a walk
        // down reads the thin spot value (same tick shape as v3-depth.test.js's "thin
        // active tick, deep neighbor above").
        const spot = ONE; // active-tick liquidity (thin)
        const deep = 1000n * ONE; // liquidity one tick above the active tick (deep)
        const hop1 = await deploy(conn, "MockV3TickPool", null, [Q96, 0, spot, 10, bAddr, t0Addr]);
        await hop1.setTick(-10, spot); // thin position [-10,+10] enters here
        await hop1.setTick(10, deep - spot); // thin exits (-spot) + deep enters (+deep)
        await hop1.setTick(1000, -deep); // deep position exits far above

        // hop2: V2-kind constant-product pool on (B, t1Tok), deep enough (1e6x the
        // hop1 swing) that it never dominates the composite and never itself walks.
        const R = 1_000_000n * ONE;
        const hop2 = await deploy(conn, "MockV2Pool", null, [bAddr, t1Addr, 9975n, 10000n]);
        await B.mint(me.address, R);
        await t1Tok.mint(me.address, R);
        await B.approve(await hop2.getAddress(), R);
        await t1Tok.approve(await hop2.getAddress(), R);
        await hop2.initReserves(R, R);

        const hop1Id = idAddr(await hop1.getAddress());
        const hop2Id = idAddr(await hop2.getAddress());
        const routeId = idRoute(hop1Id, hop2Id);

        await registry.setPools(bAddr, t0Addr, [[hop1Id, 2, 2500, 0]]); // V3, 0.25%
        await registry.setPools(bAddr, t1Addr, [[hop2Id, 0, 25, 0]]); // V2, 0.25%
        await registry.setPools(t0Addr, t1Addr, [[routeId, ROUTE, 0, 0]]); // defended pair
        await registry.setConfig(routeId, configRoute(hop1Id, hop2Id, bAddr));

        const regAddr = await registry.getAddress();
        const [sSpot] = await harness.normalize(regAddr, routeId);
        // RouteLib walks each hop to a ratio-target (sp scaled by the composite move
        // magnitude, RouteLib._hopTarget), not to the MIN/MAX_SQRT extreme. A 2x/0.5x
        // sqrtPrice move is itself a huge swing (real tick +-13864, compressed +-1386 at
        // this hop's spacing=10), far beyond where this hop's OWN liquidity already hits
        // exact zero (it crosses tick -10 going down, tick 1000 going up; see the golden
        // model below). V3Depth's walk stops on that exhaustion (liq==0) before the
        // ratio-target binds, so both moves are "far": each reads what a walk toward the
        // extreme would. A genuinely SMALL move, one the ratio-target clips, is covered
        // separately below, where it is the point.
        const defHigh = sSpot * 2n; // > spot => up=true  => near==tok1 => toMax=!up=false => walk toward MIN
        const defLow = sSpot / 2n; // < spot => up=false => near==tok1 => toMax=!up=true  => walk toward MAX

        const effHigh = await harness.effectiveLiquidity(regAddr, routeId, defHigh, 8);
        const effLow = await harness.effectiveLiquidity(regAddr, routeId, defLow, 8);
        console.log(`  near==tok1 hop: effHigh(walk toward MIN, thin)=${effHigh} effLow(walk toward MAX, deep)=${effLow}`);

        // Golden model: replicate RouteLib._compose exactly for hop1's two possible
        // walked liquidities. hop1's own price is Q96 (sp==Q96), so _vr's r0==r1==L1
        // regardless of the near/tok0 vs near/tok1 mapping, which lets this golden
        // computation stay agnostic to that mapping while still pinning the *value*
        // of L1 (and hence the composite l) to the direction under test.
        const L1_min = spot; // walking hop1 toward MIN: exhausts past tick -10, mean == spot
        const L1_max = (spot * 1n + deep * 99n) / 100n; // walking toward MAX: crosses into the deep run, exhausts past tick 1000
        function compositeL(L1) {
            const den = L1 + R; // r1.far (==L1) + r2.near (==R)
            const v0 = (L1 * R) / den;
            const v1 = (R * L1) / den;
            return isqrt(v0 * v1);
        }
        const expHigh = compositeL(L1_min);
        const expLow = compositeL(L1_max);
        expect(effHigh >= expHigh - 4n && effHigh <= expHigh + 4n, `effHigh ${effHigh} vs ${expHigh}`).to.equal(true);
        expect(effLow >= expLow - 4n && effLow <= expLow + 4n, `effLow ${effLow} vs ${expLow}`).to.equal(true);

        // The rule (near==tok1 => toMax=!up) walks AWAY from the deep side when up, so
        // defHigh reads the thin spot and defLow reads the deep run: effLow must come
        // out far larger than effHigh (order of magnitude, given deep/spot == 1000x).
        // The pair-side rule (`hop1 ? up : !up`, position-based, not near/tok0-based)
        // picks toMax=up for hop1 regardless of near/tok0, the OPPOSITE direction for
        // this hop in both calls, which would swap which side is walked and produce
        // effHigh > effLow instead, failing this assertion.
        expect(effLow).to.be.gt(effHigh);
        expect(effLow >= effHigh * 100n, `effLow ${effLow} vs effHigh ${effHigh}`).to.equal(true);
    });

    // RouteLib._hopVR walks a concentrated hop to a target scaled by the composite move
    // (RouteLib._hopTarget), not toward MIN_SQRT/MAX_SQRT: a real defended-pool
    // dislocation implies a bounded move, not the extreme. This case builds a cliffy V3
    // hop (deep at its own spot, a cliff into thin liquidity a good distance above)
    // behind a deep, neutral V2 hop, and reads the route at two defended prices: one
    // implying a small move (stays short of the cliff, reads deep) and one implying a
    // large move (crosses the cliff, reads diluted toward thin). Walked toward the
    // extreme instead, both would read the same.
    it("route hop bounded at the composite move reads deeper for a small dislocation than a large one", async function () {
        const deployed = await Promise.all([mkToken("P"), mkToken("Q"), mkToken("S")]);
        const sorted = (
            await Promise.all(deployed.map(async (t) => ({ t, a: (await t.getAddress()).toLowerCase() })))
        ).sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
        // B smallest of the three -> hop1's pool sort is (B, t0Tok), hop2's is (B, t1Tok):
        // near(B) == tok0 for hop2, the simple (non-tricky) arm; this case is about the
        // walk TARGET, not the near/tok0 direction mapping already covered above.
        const B = sorted[0].t, t0Tok = sorted[1].t, t1Tok = sorted[2].t;
        const bAddr = await B.getAddress(), t0Addr = await t0Tok.getAddress(), t1Addr = await t1Tok.getAddress();

        // hop1: deep V2 pool (t0Tok, B), equal reserves -> a neutral 1:1 composite
        // multiplier, so the composite spot lands on hop2's own spot (sp == Q96) and the
        // composite move ratio applies to hop2 directly (exactly, not just conservatively).
        const R = 1_000_000n * ONE;
        const hop1 = await deploy(conn, "MockV2Pool", null, [bAddr, t0Addr, 9975n, 10000n]);
        await B.mint(me.address, R);
        await t0Tok.mint(me.address, R);
        await B.approve(await hop1.getAddress(), R);
        await t0Tok.approve(await hop1.getAddress(), R);
        await hop1.initReserves(R, R);

        // hop2: cliffy V3 pool (B, t1Tok), pool's own sort tok0=B, tok1=t1Tok (B<t1Tok).
        // Deep at the active tick (spot), a cliff down to thin 2000 ticks above (well past
        // any tick a ~0.2% price move reaches, well short of a 2x move).
        const deep = 1000n * ONE;
        const thin = ONE;
        const hop2 = await deploy(conn, "MockV3TickPool", null, [Q96, 0, deep, 10, bAddr, t1Addr]);
        await hop2.setTick(2000, thin - deep);

        const hop1Id = idAddr(await hop1.getAddress());
        const hop2Id = idAddr(await hop2.getAddress());
        const routeId = idRoute(hop1Id, hop2Id);

        await registry.setPools(t0Addr, bAddr, [[hop1Id, 0, 25, 0]]); // V2, 0.25%
        await registry.setPools(bAddr, t1Addr, [[hop2Id, 2, 2500, 0]]); // V3, 0.25%
        await registry.setPools(t0Addr, t1Addr, [[routeId, ROUTE, 0, 0]]); // defended pair
        await registry.setConfig(routeId, configRoute(hop1Id, hop2Id, bAddr));

        const regAddr = await registry.getAddress();
        const [sSpot] = await harness.normalize(regAddr, routeId);
        const small = sSpot + sSpot / 500n; // ~0.2% move: stays short of the cliff
        const far = sSpot * 2n; // 2x move: walks past the cliff into thin
        const lSmall = await harness.effectiveLiquidity(regAddr, routeId, small, 8);
        const lFar = await harness.effectiveLiquidity(regAddr, routeId, far, 8);
        console.log(`  ratio-target: lSmall(short of cliff)=${lSmall} lFar(past cliff)=${lFar}`);
        expect(lSmall).to.be.gt(lFar); // small move stays in the deep core, large dilutes toward thin
    });
});
