import chalk from "chalk";
import debug from "debug";
import { BN, bufferToHex, privateToAddress, toBuffer } from "ethereumjs-util";
import fsExtra from "fs-extra";

import { HARDHAT_NETWORK_NAME } from "../internal/constants";
import { subtask, task, types } from "../internal/core/config/config-env";
import { HardhatError } from "../internal/core/errors";
import { ERRORS } from "../internal/core/errors-list";
import { createProvider } from "../internal/core/providers/construction";
import {
  JsonRpcServer as JsonRpcServerImpl,
  JsonRpcServerConfig,
} from "../internal/hardhat-network/jsonrpc/server";
import { Reporter } from "../internal/sentry/reporter";
import { lazyObject } from "../internal/util/lazy";
import {
  EthereumProvider,
  HardhatNetworkConfig,
  JsonRpcServer,
} from "../types";

import {
  TASK_NODE,
  TASK_NODE_CREATE_SERVER,
  TASK_NODE_GET_PROVIDER,
  TASK_NODE_SERVER_CREATED,
  TASK_NODE_SERVER_READY,
} from "./task-names";
import { watchCompilerOutput } from "./utils/watch";

const log = debug("hardhat:core:tasks:node");

function logHardhatNetworkAccounts(networkConfig: HardhatNetworkConfig) {
  if (networkConfig.accounts === undefined) {
    return;
  }

  console.log("Accounts");
  console.log("========");

  for (const [index, account] of networkConfig.accounts.entries()) {
    const address = bufferToHex(privateToAddress(toBuffer(account.privateKey)));
    const privateKey = bufferToHex(toBuffer(account.privateKey));
    const balance = new BN(account.balance)
      .div(new BN(10).pow(new BN(18)))
      .toString(10);

    console.log(`Account #${index}: ${address} (${balance} ETH)
Private Key: ${privateKey}
`);
  }
}

subtask(TASK_NODE_GET_PROVIDER)
  .addOptionalParam("forkUrl", undefined, undefined, types.string)
  .addOptionalParam("forkBlockNumber", undefined, undefined, types.int)
  .setAction(
    async (
      {
        forkBlockNumber: forkBlockNumberParam,
        forkUrl: forkUrlParam,
      }: {
        forkBlockNumber?: number;
        forkUrl?: string;
      },
      { artifacts, config, network }
    ): Promise<EthereumProvider> => {
      let provider = network.provider;

      if (network.name !== HARDHAT_NETWORK_NAME) {
        const networkConfig = config.networks[HARDHAT_NETWORK_NAME];

        log(`Creating hardhat provider for JSON-RPC server`);
        provider = createProvider(
          HARDHAT_NETWORK_NAME,
          networkConfig,
          config.paths,
          artifacts
        );
      }

      const hardhatNetworkConfig = config.networks[HARDHAT_NETWORK_NAME];

      const forkUrl = forkUrlParam ?? hardhatNetworkConfig.forking?.url;
      const forkBlockNumber =
        forkBlockNumberParam ?? hardhatNetworkConfig.forking?.blockNumber;

      // we use the hardhat_reset RPC method to enable the fork
      if (forkUrl !== undefined) {
        await provider.request({
          method: "hardhat_reset",
          params: [
            {
              forking: {
                jsonRpcUrl: forkUrl,
                blockNumber: forkBlockNumber,
              },
            },
          ],
        });
      } else if (forkBlockNumber !== undefined) {
        // we throw an error if the user specified a forkBlockNumber but not a
        // forkUrl
        throw new HardhatError(
          ERRORS.BUILTIN_TASKS.NODE_FORK_BLOCK_NUMBER_WITHOUT_URL
        );
      }

      // enable logging
      await provider.request({
        method: "hardhat_setLoggingEnabled",
        params: [true],
      });

      return provider;
    }
  );

subtask(TASK_NODE_CREATE_SERVER)
  .addParam("hostname", undefined, undefined, types.string)
  .addParam("port", undefined, undefined, types.int)
  .addParam("provider", undefined, undefined, types.any)
  .setAction(
    async ({
      hostname,
      port,
      provider,
    }: {
      hostname: string;
      port: number;
      provider: EthereumProvider;
    }): Promise<JsonRpcServer> => {
      const serverConfig: JsonRpcServerConfig = {
        hostname,
        port,
        provider,
      };

      const server = new JsonRpcServerImpl(serverConfig);

      return server;
    }
  );

/**
 * This task will be called when the server was successfully created, but it's
 * not ready for receiving requests yet.
 */
subtask(TASK_NODE_SERVER_CREATED)
  .addParam("hostname", undefined, undefined, types.string)
  .addParam("port", undefined, undefined, types.int)
  .addParam("provider", undefined, undefined, types.any)
  .addParam("server", undefined, undefined, types.any)
  .setAction(
    async ({}: {
      hostname: string;
      port: number;
      provider: EthereumProvider;
      server: JsonRpcServer;
    }) => {
      // this task is meant to be overriden by plugin writers
    }
  );

/**
 * This subtask will be run when the server is ready to accept requests
 */
subtask(TASK_NODE_SERVER_READY)
  .addParam("address", undefined, undefined, types.string)
  .addParam("port", undefined, undefined, types.int)
  .addParam("provider", undefined, undefined, types.any)
  .addParam("server", undefined, undefined, types.any)
  .setAction(
    async (
      {
        address,
        port,
      }: {
        address: string;
        port: number;
        provider: EthereumProvider;
        server: JsonRpcServer;
      },
      { config }
    ) => {
      console.log(
        chalk.green(
          `Started HTTP and WebSocket JSON-RPC server at http://${address}:${port}/`
        )
      );

      console.log();

      const networkConfig = config.networks[HARDHAT_NETWORK_NAME];
      logHardhatNetworkAccounts(networkConfig);
    }
  );

task(TASK_NODE, "Starts a JSON-RPC server on top of Hardhat Network")
  .addOptionalParam(
    "hostname",
    "The host to which to bind to for new connections (Defaults to 127.0.0.1 running locally, and 0.0.0.0 in Docker)",
    undefined,
    types.string
  )
  .addOptionalParam(
    "port",
    "The port on which to listen for new connections",
    8545,
    types.int
  )
  .addOptionalParam(
    "forkUrl",
    "The URL of the JSON-RPC server to fork from",
    undefined,
    types.string
  )
  .addOptionalParam(
    "forkBlockNumber",
    "The block number to fork from",
    undefined,
    types.int
  )
  .setAction(
    async (
      {
        forkBlockNumber,
        forkUrl,
        hostname: hostnameParam,
        port,
      }: {
        forkBlockNumber?: number;
        forkUrl?: string;
        hostname?: string;
        port: number;
      },
      { config, hardhatArguments, network, run }
    ) => {
      // we throw if the user specified a network argument and it's not hardhat
      if (
        network.name !== HARDHAT_NETWORK_NAME &&
        hardhatArguments.network !== undefined
      ) {
        throw new HardhatError(
          ERRORS.BUILTIN_TASKS.JSONRPC_UNSUPPORTED_NETWORK
        );
      }

      try {
        const provider: EthereumProvider = await run(TASK_NODE_GET_PROVIDER, {
          forkBlockNumber,
          forkUrl,
        });

        // the default hostname is "localhost" unless we are inside a docker
        // container, in that case we use "0.0.0.0"
        let hostname: string;
        if (hostnameParam !== undefined) {
          hostname = hostnameParam;
        } else {
          const insideDocker = fsExtra.existsSync("/.dockerenv");
          if (insideDocker) {
            hostname = "0.0.0.0";
          } else {
            hostname = "localhost";
          }
        }

        const server: JsonRpcServer = await run(TASK_NODE_CREATE_SERVER, {
          hostname,
          port,
          provider,
        });

        await run(TASK_NODE_SERVER_CREATED, {
          hostname,
          port,
          provider,
          server,
        });

        const { port: actualPort, address } = await server.listen();

        try {
          await watchCompilerOutput(provider, config.paths);
        } catch (error) {
          console.warn(
            chalk.yellow(
              "There was a problem watching the compiler output, changes in the contracts won't be reflected in the Hardhat Network. Run Hardhat with --verbose to learn more."
            )
          );

          log(
            "Compilation output can't be watched. Please report this to help us improve Hardhat.\n",
            error
          );

          Reporter.reportError(error);
        }

        await run(TASK_NODE_SERVER_READY, {
          address,
          port: actualPort,
          provider,
          server,
        });

        await server.waitUntilClosed();
      } catch (error) {
        if (HardhatError.isHardhatError(error)) {
          throw error;
        }

        throw new HardhatError(
          ERRORS.BUILTIN_TASKS.JSONRPC_SERVER_ERROR,
          {
            error: error.message,
          },
          error
        );
      }
    }
  );
