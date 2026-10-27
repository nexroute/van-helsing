import { blockParam } from "./simulate.js";

// What the wards pay per gas: the swap's own price, since they go out with it, in its
// transaction or in its bundle. A gasPrice is paid as it is. An EIP-1559 swap pays the base fee
// of the block after `block` plus its tip, at most its maxFeePerGas. A tip the swap leaves out
// is the node's suggested one, as a wallet would set it, and without maxFeePerGas nothing caps it.
export async function gasPriceOf(tx, { client, block = "latest" }) {
    if (tx.gasPrice != null) return BigInt(tx.gasPrice);
    const [history, tip] = await Promise.all([
        client.request({ method: "eth_feeHistory", params: ["0x1", blockParam(block), []] }),
        tx.maxPriorityFeePerGas ?? client.request({ method: "eth_maxPriorityFeePerGas" }),
    ]);
    // eth_feeHistory gives one base fee more than the blocks it covers: the next block's
    const price = BigInt(history.baseFeePerGas.at(-1)) + BigInt(tip);
    const cap = tx.maxFeePerGas != null ? BigInt(tx.maxFeePerGas) : price;
    return price < cap ? price : cap;
}
