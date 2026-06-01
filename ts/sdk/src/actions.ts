import type {
  Keypair,
  SendOptions,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";

/// A minimal connection shape, intentionally looser than web3.js `Connection`.
/// `Connection.sendTransaction` is overloaded and `confirmTransaction` returns
/// `{ context, value }`, so a small mock or a custom RPC client would not match
/// `Pick<Connection, ...>`. This interface keeps the action wrapper testable and
/// swappable while a real `Connection` still satisfies it.
export type MinimalConnection = {
  sendTransaction(
    tx: Transaction,
    signers: Keypair[],
    options?: SendOptions,
  ): Promise<TransactionSignature>;
  confirmTransaction(
    signature: TransactionSignature,
    commitment?: string,
  ): Promise<{ value: { err: unknown } }>;
};

export type OpenPerpsActionsConfig = {
  connection: MinimalConnection;
  sendOptions?: SendOptions;
};

export type OpenPerpsActions = {
  sendTransaction(tx: Transaction, signers: Keypair[]): Promise<TransactionSignature>;
};

/// Send-ready helpers for Node scripts, bots, and backends: sign, send, and
/// confirm in one call. Browser apps that want the wallet to sign should use the
/// build-only helpers in `transactions.ts` instead.
export function createOpenPerpsActions(config: OpenPerpsActionsConfig): OpenPerpsActions {
  return {
    async sendTransaction(tx, signers) {
      const signature = await config.connection.sendTransaction(
        tx,
        signers,
        config.sendOptions,
      );
      await config.connection.confirmTransaction(signature, "confirmed");
      return signature;
    },
  };
}
