// HH3: ethers, networkHelpers and provider are connection-scoped, so each helper
// takes the connection (`const conn = await network.connect(...)`).

const as = async (conn, account) => {
    const { ethers, networkHelpers } = conn;
    await networkHelpers.impersonateAccount(account);
    await networkHelpers.setBalance(account, 100n * (10n ** 18n));
    return ethers.getSigner(account);
};

const sendTokens = async (conn, fromToken, fromLp, toAddress, amount) => {
    const { ethers, networkHelpers } = conn;
    const erc20 = await ethers.getContractAt("IERC20", fromToken);
    await networkHelpers.impersonateAccount(fromLp);
    await networkHelpers.setBalance(fromLp, 100n * (10n ** 18n));
    const signer = await ethers.getSigner(fromLp);
    await erc20.connect(signer).transfer(toAddress, amount);
    await networkHelpers.stopImpersonatingAccount(fromLp);
};

const BALANCE_OF_SELECTOR = "0x70a08231";
const encodeBalanceOf = (account) =>
    BALANCE_OF_SELECTOR + account.slice(2).toLowerCase().padStart(64, "0");

const setTokens = async (conn, addr, amount, account) => {
    const { provider, networkHelpers } = conn;
    const data = encodeBalanceOf(account);

    const trace = await provider.request({ method: "debug_traceCall", params: [
        { to: addr, data },
        await provider.request({ method: "eth_blockNumber" }),
        { enableMemory: false, disableStack: false, disableStorage: true },
    ] });

    const accessedSlots = trace.structLogs
        .filter((log) => log.op === "SLOAD")
        .map((log) => {
            const s = log.stack[log.stack.length - 1];
            const h = s.startsWith("0x") ? s.slice(2) : s; // EDR prefixes stack words with 0x
            return `0x${h.padStart(64, "0")}`;
        });

    const balanceSlot = accessedSlots[0];

    await networkHelpers.setStorageAt(addr, balanceSlot, amount);

    const balanceHex = await provider.request({ method: "eth_call", params: [{ to: addr, data }, "latest"] });
    const balance = BigInt(balanceHex);
    if (balance !== amount) {
        throw new Error(`Failed to set balance for ${account} on token ${addr}`);
    }
};

export { as, sendTokens, setTokens };
