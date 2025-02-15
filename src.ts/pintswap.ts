import { protocol } from "./protocol";
import { PintP2P } from "./p2p";
import { BigNumberish, ethers } from "ethers";
import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import {
  TPCEcdsaKeyGen as TPC,
  TPCEcdsaSign as TPCsign,
} from "@safeheron/two-party-ecdsa-js";
import { EventEmitter } from "events";
import { SignatureTransfer, PERMIT2_ADDRESS } from "@uniswap/permit2-sdk";
import pushable from "it-pushable";
import { uniq, mapValues } from "lodash";
import { toBigInt, toWETH } from "./trade";
import BN from "bn.js";
import {
  keyshareToAddress,
  createContract,
  leftZeroPad,
  hashOffer,
  coerceToWeth,
  genericAbi,
  defer,
} from "./trade";
import { IOffer } from "./types";
import PeerId from "peer-id";
import { createLogger } from "./logger";
import * as permit from "./permit";
import fetch from "cross-fetch";
const { getAddress, getCreateAddress, Contract, Transaction } = ethers;

const logger = createLogger("pintswap");
const ln = (v) => (
  console.log(require("util").inspect(v, { colors: true, depth: 15 })), v
);

const getGasPrice = async (provider) => {
  if (provider.getGasPrice) return await provider.getGasPrice();
  return (await provider.getFeeData()).gasPrice;
};

const signTypedData = async (signer, ...args) => {
  if (signer.signTypedData) return await signer.signTypedData(...args);
  return await signer._signTypedData(...args);
};

let id = 0;
export async function sendFlashbotsTransaction(data) {
  const response = await fetch("https://rpc.flashbots.net", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      id: id++,
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [data],
    }),
  });
  return await response.json();
}

const getPermitData = (signatureTransfer) => {
  const { domain, types, values } = SignatureTransfer.getPermitData(
    signatureTransfer.permit,
    signatureTransfer.permit2Address,
    signatureTransfer.chainId
  );
  return [domain, types, values];
};

export class PintswapTrade extends EventEmitter {
  public hashes: null | string[];
  public _deferred: ReturnType<typeof defer>;
  constructor() {
    super();
    this._deferred = defer();
    this.hashes = null;
  }
  async toPromise() {
    return await this._deferred.promise;
  }
  resolve(v?: any) {
    this.emit("complete", v);
    this._deferred.resolve(v);
  }
  reject(err) {
    this.emit("error", err);
    this._deferred.reject(err);
  }
}

export function encodeBatchFill(o) {
  return protocol.BatchFill.encode({
    fills: o.map((v) => ({
      offerHash: Buffer.from(ethers.toBeArray(v.offerHash)),
      amount: Buffer.from(ethers.toBeArray(ethers.getUint(v.amount))),
    })),
  }).finish();
}

export function decodeBatchFill(data) {
  const { fills } = protocol.BatchFill.toObject(
    protocol.BatchFill.decode(data),
    {
      enums: String,
      longs: String,
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true,
      oneofs: true,
    }
  );
  return fills.map((v) => ({
    offerHash: ethers.hexlify(ethers.decodeBase64(v.offerHash)),
    amount: ethers.getUint(ethers.hexlify(ethers.decodeBase64(v.amount))),
  }));
}

export function scaleOffer(offer: IOffer, amount: BigNumberish) {
  if (ethers.getUint(amount) > ethers.getUint(offer.getsAmount))
    throw Error("fill amount exceeds order capacity");
  return {
    givesToken: offer.givesToken,
    getsToken: offer.getsToken,
    givesAmount: ethers.hexlify(
      ethers.toBeArray(
        (ethers.getUint(offer.givesAmount) * ethers.getUint(amount)) /
          ethers.getUint(offer.getsAmount)
      )
    ),
    getsAmount: ethers.hexlify(ethers.toBeArray(ethers.getUint(amount))),
  };
}

export function toBigIntFromBytes(b) {
  if (b === "0x" || b.length === 0) return BigInt(0);
  return ethers.toBigInt(b);
}

export function sumOffers(offers: any[]) {
  return offers.reduce(
    (r, v) => ({
      getsToken: v.getsToken,
      givesToken: v.givesToken,
      getsAmount: ethers.toBeHex(
        toBigIntFromBytes(v.getsAmount) + toBigIntFromBytes(r.getsAmount)
      ),
      givesAmount: ethers.toBeHex(
        toBigIntFromBytes(v.givesAmount) + toBigIntFromBytes(r.givesAmount)
      ),
    }),
    { getsAmount: ethers.toBigInt(0), givesAmount: ethers.toBigInt(0) }
  );
}

export const NS_MULTIADDRS = {
  DRIP: ['QmUtvU33iaHun99yD9HgiyLSrmPhWUbXVX2hAZRY4AEV2d']
};

export class Pintswap extends PintP2P {
  public signer: any;
  public offers: Map<string, IOffer> = new Map();
  public logger: ReturnType<typeof createLogger>;
  public peers: Map<string, [string, IOffer]>;
  public _awaitReceipts: boolean;

  static async initialize({ awaitReceipts, signer }) {
    const peerId = await PeerId.create();
    return new Pintswap({ signer, awaitReceipts, peerId });
  }

  async resolveName(name) {
    const parts = name.split('.');
    const query = parts.slice(0, Math.max(parts.length - 1, 1)).join('.');
    const tld = parts.length === 1 ? 'drip' : parts[parts.length - 1];
    const messages = pushable();
    const response: any = await new Promise((resolve, reject) => {
      (async () => {
        const nsHosts = NS_MULTIADDRS[tld.toUpperCase()];
        const { stream } = await this.dialProtocol(PeerId.createFromB58String(nsHosts[Math.floor(nsHosts.length*Math.random())]), '/pintswap/0.1.0/ns/query');
	pipe(messages, lp.encode(), stream.sink);
	messages.push(protocol.NameQuery.encode({
          name: query
	}).finish());
	messages.end();
	const it = pipe(stream.source, lp.decode());
	const response = protocol.NameQueryResponse.decode((await it.next()).value.slice());
	resolve({
          status: response.status,
	  result: response.result
	});
      })().catch(reject);
    });
    if (response.status === 0) throw Error('no name registered');
    return response.result + (parts.length > 1 ? '' : '.' + tld);
  }
  async registerName(name) {
    let parts = name.split('.');
    const query = parts.slice(0, -1).join('.');
    const tld = parts[parts.length - 1];
    const messages = pushable();
    const response = await new Promise((resolve, reject) => {
      (async () => {
        const nsHosts = NS_MULTIADDRS[tld.toUpperCase()];
        const { stream } = await this.dialProtocol(PeerId.createFromB58String(nsHosts[Math.floor(nsHosts.length*Math.random())]), '/pintswap/0.1.0/ns/register');
	pipe(messages, lp.encode(), stream.sink);
	messages.push(Buffer.from(query));
	messages.end();
	const it = await pipe(stream.source, lp.decode());
	const response = protocol.NameRegisterResponse.decode((await it.next()).value.slice());
	resolve({
          status: response.status
	});
      })().catch(reject);
    });
    return response;
  }
  constructor({ awaitReceipts, signer, peerId }) {
    super({ signer, peerId });
    this.signer = signer;
    this.logger = logger;
    this.peers = new Map<string, [string, IOffer]>();
    this._awaitReceipts = awaitReceipts || false;
  }

  async publishOffers() {
    await this.pubsub.publish(
      "/pintswap/0.1.0/publish-orders",
      ethers.toBeArray(ethers.hexlify(this._encodeOffers()))
    );
  }
  startPublishingOffers(ms: number) {
    if (!ms) ms = 10000;
    let end = false;
    (async () => {
      while (!end) {
        try {
          await this.publishOffers();
        } catch (e) {
          this.logger.error(e);
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
    })().catch((err) => this.logger.error(err));
    return {
      setInterval(_ms) {
        ms = _ms;
      },
      stop() {
        end = true;
      },
    };
  }
  async subscribeOffers() {
    this.pubsub.on("/pintswap/0.1.0/publish-orders", (message) => {
      this.logger.debug(
        `\n PUBSUB: TOPIC-${message.topicIDs[0]} \n FROM: PEER-${message.from}`
      );
      this.logger.info(message.data);
      const offers = this._decodeOffers(message.data).offers;
      let _offerhash = ethers.keccak256(message.data);
      const pair: [string, IOffer] = [_offerhash, offers];
      this.logger.info(pair);
      if (this.peers.has(message.from)) {
        if (this.peers.get(message.from)[0] == _offerhash) return;
        this.peers.set(message.from, pair);
        this.emit("/pubsub/orderbook-update");
        return;
      }
      this.peers.set(message.from, pair);
      this.emit("/pubsub/orderbook-update");
    });
    this.pubsub.subscribe("/pintswap/0.1.0/publish-orders");
  }
  async startNode() {
    await this.handleBroadcastedOffers();
    await this.start();
    await this.pubsub.start();
    this.emit(`pintswap/node/status`, 1);
  }

  async stopNode() {
    await this.unhandle([
      "/pintswap/0.1.0/orders",
      "/pintswap/0.1.0/create-trade",
    ]);
    await this.stop();
    this.emit(`pintswap/node/status`, 0);
  }

  _encodeOffers() {
    return protocol.OfferList.encode({
      offers: [...this.offers.values()].map((v) =>
        mapValues(v, (v) => Buffer.from(ethers.toBeArray(v)))
      ),
    }).finish();
  }
  async handleBroadcastedOffers() {
    const address = await this.signer.getAddress();
    await this.handle("/pintswap/0.1.0/orders", ({ stream }) => {
      try {
        this.logger.debug("handling order request from peer");
        this.emit("pintswap/trade/peer", 2); // maker sees that taker is connected
        let offerList = this._encodeOffers();
        const messages = pushable();
        pipe(messages, lp.encode(), stream.sink);
        messages.push(offerList);
        messages.end();
      } catch (e) {
        this.logger.error(e);
      }
    });

    await this.handle(
      "/pintswap/0.1.0/create-trade",
      async ({ stream, connection, protocol }) => {
        const trade = new PintswapTrade();
        this.emit("trade:maker", trade);
        this.emit(`/pintswap/request/create-trade`);
        const context2 = await TPC.P2Context.createContext();
        const messages = pushable();
        const self = this;

        pipe(stream.source, lp.decode(), async function (source) {
          let offerHashHex, offer, offers, batchFill, originalOffers;
          try {
            const { value: batchFillBufList } = await source.next();
            batchFill = decodeBatchFill(batchFillBufList.slice());
            ln("batch fill decode");
            ln(batchFill);
            originalOffers = batchFill.map((v) => self.offers.get(v.offerHash));
            offers = batchFill.map((v, i) => ({
              ...scaleOffer(originalOffers[i], v.amount),
            }));
            if (
              uniq(offers.map((v) => ethers.getAddress(v.getsToken))).length !==
                1 ||
              uniq(offers.map((v) => ethers.getAddress(v.givesToken)))
                .length !== 1
            )
              throw Error("must fill orders for same trade pair");
            offerHashHex = ethers.hexlify(batchFillBufList.slice());
            offer = ln(sumOffers(ln(offers)));
            offers.forEach((v, i) => {
              self.offers.delete(batchFill[i].offerHash);
            });
            batchFill.forEach((v) => trade.emit("hash", v.offerHash));
            trade.hashes = batchFill.map((v) => v.offerHash);
            const { value: keygenMessage1 } = await source.next();
            self.emit("pintswap/trade/maker", 0); // maker sees that taker clicked "fulfill trade"
            trade.emit("progress", 0);
            self.logger.debug(
              `MAKER:: /event/ecdsa-keygen/party/2 handling message: 1`
            );
            messages.push(context2.step1(keygenMessage1.slice()));
            messages.push(Buffer.from(address.substr(2), "hex"));
            self.logger.debug(
              "MAKER: pushed context2.step1(message) + address"
            );
            const { value: keygenMessage3 } = await source.next();
            self.logger.debug(
              `MAKER:: /event/ecdsa-keygen/party/2 handling message: 3`
            );
            context2.step2(keygenMessage3.slice());
            // set keyshare and shared address
            const keyshareJson = context2.exportKeyShare().toJsonObject();
            const sharedAddress = keyshareToAddress(keyshareJson);
            self.emit(
              `pintswap/request/create-trade/fulfilling`,
              offerHashHex,
              offer
            ); // emits offer hash and offer object to frontend
            trade.emit("fulfilling", {
              hash: offerHashHex,
              offer,
            });
            const tx = await self.approveTradeAsMaker(
              offer,
              sharedAddress as string
            );
            console.log("tx", tx);
            if (tx.permitData) {
              const encoded = permit.encode(tx.permitData);
              messages.push(encoded);
            } else {
              await self.signer.provider.waitForTransaction(tx.hash);
              messages.push(Buffer.from([]));
            }
            self.emit("pintswap/trade/maker", 1); // maker sees the taker signed tx
            trade.emit("progress", 1);
            self.logger.debug(
              `MAKER:: /event/approve-contract approved offer with offer hash: ${offerHashHex}`
            );
            self.logger.debug("MAKER: WAITING FOR APPROVE");
            self.logger.debug("MAKER: GOT APPROVE");

            self.logger.debug("SHOULD RECEIVE PERMITDATA");
            const { value: takerPermitDataBytes } = await source.next();
            const takerPermitDataSlice = takerPermitDataBytes.slice();
            const takerPermitData =
              takerPermitDataSlice.length &&
              permit.decode(takerPermitDataSlice);
            self.logger.debug(
              "TAKERPERMITDATA: " + ethers.hexlify(takerPermitDataSlice)
            );
            self.logger.debug("SHOULD RECEIVE SERIALIZED");
            const { value: serializedTxBufList } = await source.next();
            self.logger.debug("MAKER: RECEIVED SERIALIZED");
            const { value: payCoinbaseAmountBufList } = await source.next();
            self.logger.debug("MAKER: RECEIVED PAYCOINBASEAMOUNT");
            const payCoinbaseAmountBuffer = payCoinbaseAmountBufList.slice();
            const payCoinbaseAmount = payCoinbaseAmountBuffer.length
              ? ethers.hexlify(
                  ethers.toBeArray(
                    "0x" + payCoinbaseAmountBuffer.toString("hex")
                  )
                )
              : null;
            self.logger.debug("MAKER: pay coinbase " + payCoinbaseAmount);

            const serializedTx = serializedTxBufList.slice();
            self.logger.debug("RECEIVED SERIALIZED");
            self.logger.debug(ethers.hexlify(serializedTx.slice()));
            const { value: _takerAddress } = await source.next();
            const takerAddress = ethers.getAddress(
              ethers.hexlify(_takerAddress.slice())
            );
            self.logger.debug("RECEIVED TAKERADDRESS", takerAddress);
            const serialized = ethers.hexlify(serializedTx);
            self.logger.debug(
              `MAKER:: /event/ecdsa-sign/party/2/init received transaction: ${serialized}`
            );
            const transaction = ethers.Transaction.from(serialized);
            if (transaction.to) {
              throw Error("transaction must not have a recipient");
            }
            /*
            if (
              ethers.getUint(transaction.gasPrice) >
              BigInt(500000) * BigInt(await getGasPrice(self.signer.provider))
            ) {
              throw Error("transaction.gasPrice is unrealistically high");
            }
	   */
            self.logger.debug("comparing contract");

            let contractPermitData = {} as any;
            if (takerPermitData) contractPermitData.taker = takerPermitData;
            if (tx.permitData) contractPermitData.maker = tx.permitData;
            if (!Object.keys(contractPermitData).length)
              contractPermitData = null;
            if (
              transaction.data !==
              createContract(
                offer,
                await self.signer.getAddress(),
                takerAddress,
                Number((await self.signer.provider.getNetwork()).chainId),
                contractPermitData,
                payCoinbaseAmount
              )
            )
              throw Error("transaction data is not a pintswap");
            self.logger.debug("MAKER: making signContext");
            const signContext = await TPCsign.P2Context.createContext(
              JSON.stringify(keyshareJson, null, 4),
              new BN(transaction.unsignedHash.substr(2), 16)
            );

            const { value: signMessage1BufList } = await source.next();
            const signMessage1 = signMessage1BufList.slice();
            self.logger.debug("MAKER: received signMessage1");
            self.logger.debug(
              `MAKER:: /event/ecdsa-sign/party/2 handling message: 1`
            );
            messages.push(signContext.step1(signMessage1));
            self.logger.debug("MAKER: pushed signContext.step1(message)");
            const { value: signMessage3BufList } = await source.next();
            const signMessage3 = signMessage3BufList.slice();
            self.logger.debug(
              `MAKER:: /event/ecdsa-sign/party/2 handling message 2`
            );
            self.emit("pintswap/trade/maker", 2); // maker: swap is complete
            messages.push(signContext.step2(signMessage3));
            messages.end();
            trade.resolve();
          } catch (e) {
            if (offers && batchFill) {
              originalOffers.forEach((offer) => {
                self.offers.set(hashOffer(offer), offer);
              });
            }
            self.logger.error(e);
            trade.reject(e);
          }
        });
        try {
          await pipe(messages, lp.encode(), stream.sink);
        } catch (e) {
          trade.reject(e);
        }
      }
    );
  }

  // adds new offer to this.offers: Map<hash, IOffer>
  broadcastOffer(_offer: IOffer) {
    this.logger.debug("trying to list new offer");
    const hash = hashOffer(_offer);
    this.offers.set(hash, _offer);
    this.emit("pintswap/trade/broadcast", hash);
  }

  // Takes in a peerId and returns a list of exisiting trades
  async getTradesByPeerId(peerId: string) {
    let pid = PeerId.createFromB58String(peerId);
    while (true) {
      try {
        await this.peerRouting.findPeer(pid);
        break;
      } catch (e) {
        this.logger.error(e);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    this.emit("pintswap/trade/peer", 0); // start finding peer's orders
    const { stream } = await this.dialProtocol(pid, "/pintswap/0.1.0/orders");
    this.emit("pintswap/trade/peer", 1); // peer found
    const decoded = pipe(stream.source, lp.decode());
    const { value: offerListBufferList } = await decoded.next();
    const result = offerListBufferList.slice();
    this.emit("pintswap/trade/peer", 2); // got offers
    const offerList = this._decodeOffers(result);
    this.emit("pintswap/trade/peer", 3); // offers decoded and returning
    return offerList;
  }
  _decodeOffers(data: Buffer) {
    let offerList = protocol.OfferList.toObject(
      protocol.OfferList.decode(data),
      {
        enums: String,
        longs: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true,
      }
    );

    let remap = offerList.offers.map((v) => {
      return mapValues(v, (v) => {
        const address = ethers.hexlify(ethers.decodeBase64(v));
        return "0x" + leftZeroPad(address.substr(2), 40);
      });
    });
    return Object.assign(offerList, { offers: remap });
  }
  async getTradeAddress(sharedAddress: string) {
    const address = getCreateAddress({
      nonce: await this.signer.provider.getTransactionCount(sharedAddress),
      from: sharedAddress,
    });
    this.logger.debug("TRADE ADDRESS: " + address);
    return address;
  }
  async approveTradeAsMaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    const token = new Contract(
      await coerceToWeth(ethers.getAddress(offer.givesToken), this.signer),
      genericAbi,
      this.signer
    );
    this.logger.debug("MAKER ADDRESS", await this.signer.getAddress());
    this.logger.debug(
      "MAKER BALANCE BEFORE APPROVING " +
        ethers.formatEther(
          await token.balanceOf(await this.signer.getAddress())
        )
    );
    if (offer.givesToken === ethers.ZeroAddress) {
      const { chainId } = await this.signer.provider.getNetwork();
      const weth = new ethers.Contract(
        toWETH(Number(chainId)),
        [
          "function deposit()",
          "function balanceOf(address) view returns (uint256)",
        ],
        this.signer
      );
      const depositTx = await weth.deposit({ value: offer.givesAmount });
      if (this._awaitReceipts)
        await this.signer.provider.waitForTransaction(depositTx.hash);
      this.logger.debug(
        "MAKER: WETH BALANCE " +
          ethers.formatEther(
            await weth.balanceOf(await this.signer.getAddress())
          )
      );
    }
    if (
      getAddress(offer.givesToken) === getAddress(permit.ASSETS.ETHEREUM.USDC)
    ) {
      const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
      const permitData = await permit.sign(
        {
          asset: offer.givesToken,
          value: offer.givesAmount,
          spender: tradeAddress,
          owner: await this.signer.getAddress(),
          expiry,
        },
        this.signer
      );
      return {
        permitData,
        async wait() {
          return {};
        },
      };
    } else if (
      Number((await this.signer.provider.getNetwork()).chainId) === 1
    ) {
      const tx = await this.approvePermit2(offer.givesToken);
      if (tx && this._awaitReceipts)
        await this.signer.provider.waitForTransaction(tx.hash);
      const signatureTransfer = {
        permit: {
          permitted: {
            token: await coerceToWeth(offer.givesToken, this.signer),
            amount: offer.givesAmount,
          },
          spender: tradeAddress,
          nonce: ethers.hexlify(
            ethers.toBeArray(ethers.getUint(Math.floor(Date.now() / 1000)))
          ),
          deadline: ethers.hexlify(
            ethers.toBeArray(
              ethers.getUint(Math.floor(Date.now() / 1000)) +
                BigInt(60 * 60 * 24)
            )
          ),
        },
        permit2Address: PERMIT2_ADDRESS,
        chainId: 1,
      };
      const signature = await signTypedData(
        this.signer,
        ...getPermitData(signatureTransfer)
      );
      return {
        permitData: {
          signatureTransfer: signatureTransfer.permit,
          signature,
        },
        async wait() {
          return {};
        },
      };
    } else {
      const tx = await token.approve(tradeAddress, offer.givesAmount);
      this.logger.debug("TRADE ADDRESS", tradeAddress);
      this.logger.debug(
        "MAKER BALANCE AFTER APPROVING " +
          ethers.formatEther(
            await token.balanceOf(await this.signer.getAddress())
          )
      );
      this.logger.debug(
        "MAKER ALLOWANCE AFTER APPROVING " +
          ethers.formatEther(
            await token.allowance(await this.signer.getAddress(), tradeAddress)
          )
      );
      return tx;
    }
  }
  async approvePermit2(asset: string) {
    const token = new Contract(
      await coerceToWeth(asset, this.signer),
      genericAbi,
      this.signer
    );
    const allowance = await token.allowance(
      await this.signer.getAddress(),
      PERMIT2_ADDRESS
    );
    if (ethers.getUint(allowance) < ethers.getUint("0x0" + "f".repeat(63))) {
      return await token.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
    }
    return null;
  }

  async approveTradeAsTaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    const address = await coerceToWeth(
      getAddress(offer.getsToken),
      this.signer
    );
    const token = new Contract(address, genericAbi, this.signer);
    this.logger.debug("TAKER ADDRESS", await this.signer.getAddress());
    this.logger.debug(
      "TAKER BALANCE BEFORE APPROVING " +
        ethers.formatEther(
          await token.balanceOf(await this.signer.getAddress())
        )
    );
    if (offer.getsToken === ethers.ZeroAddress) {
      const { chainId } = await this.signer.provider.getNetwork();
      const weth = new ethers.Contract(
        toWETH(Number(chainId)),
        [
          "function deposit()",
          "function balanceOf(address) view returns (uint256)",
        ],
        this.signer
      );
      const depositTx = await weth.deposit({ value: offer.getsAmount });
      if (this._awaitReceipts)
        await this.signer.provider.waitForTransaction(depositTx.hash);
      this.logger.debug(
        "TAKER: WETH BALANCE " +
          ethers.formatEther(
            await weth.balanceOf(await this.signer.getAddress())
          )
      );
    }
    if (
      getAddress(offer.getsToken) === getAddress(permit.ASSETS.ETHEREUM.USDC)
    ) {
      const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
      const permitData = await permit.sign(
        {
          asset: offer.getsToken,
          value: offer.getsAmount,
          spender: tradeAddress,
          owner: await this.signer.getAddress(),
          expiry,
        },
        this.signer
      );
      return {
        permitData,
        async wait() {
          return {};
        },
      };
    } else if (
      Number((await this.signer.provider.getNetwork()).chainId) === 1
    ) {
      const tx = await this.approvePermit2(offer.getsToken);
      if (tx && this._awaitReceipts)
        await this.signer.provider.waitForTransaction(tx.hash);
      const signatureTransfer = {
        permit: {
          permitted: {
            token: await coerceToWeth(offer.getsToken, this.signer),
            amount: offer.getsAmount,
          },
          spender: tradeAddress,
          nonce: ethers.hexlify(
            ethers.toBeArray(ethers.getUint(Math.floor(Date.now() / 1000)))
          ),
          deadline: ethers.hexlify(
            ethers.toBeArray(
              ethers.getUint(Math.floor(Date.now() / 1000)) +
                BigInt(60 * 60 * 24)
            )
          ),
        },
        permit2Address: PERMIT2_ADDRESS,
        chainId: 1,
      };
      const signature = await signTypedData(
        this.signer,
        ...getPermitData(signatureTransfer)
      );
      return {
        permitData: {
          signatureTransfer: signatureTransfer.permit,
          signature,
        },
        async wait() {
          return {};
        },
      };
    } else {
      const tx = await token.approve(tradeAddress, offer.getsAmount);
      this.logger.debug(
        "TAKER BALANCE AFTER APPROVING " +
          ethers.formatEther(
            await token.balanceOf(await this.signer.getAddress())
          )
      );
      return tx;
    }
  }
  async prepareTransaction(
    offer: IOffer,
    maker: string,
    sharedAddress: string,
    permitData: any
  ) {
    const chainId = Number((await this.signer.provider.getNetwork()).chainId);
    const payCoinbase = Boolean(
      false &&
        [offer.givesToken, offer.getsToken].find(
          (v) => ethers.ZeroAddress === v
        )
    );
    const taker = await this.signer.getAddress();
    let contract = createContract(
      offer,
      maker,
      taker,
      chainId,
      permitData,
      payCoinbase ? "0x01" : null
    );
    const gasPrice = toBigInt(await getGasPrice(this.signer.provider));
    console.log(contract);

    const gasLimit = await (async () => {
      do {
        try {
          return (
            toBigInt(
              await this.signer.provider.estimateGas({
                data: contract,
                from: sharedAddress,
                //          gasPrice,
              })
            ) + BigInt(26000)
          );
        } catch (e) {
          this.logger.error(e);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } while (true);
    })();
    const payCoinbaseAmount = payCoinbase
      ? ethers.hexlify(ethers.toBeArray(gasLimit * gasPrice))
      : null;
    this.logger.debug("GASLIMIT: " + String(Number(gasLimit)));
    return Object.assign(
      payCoinbase
        ? {
            maxPriorityFeePerGas: BigInt(0),
            maxFeePerGas: ethers.getUint(
              (
                await this.signer.provider.getBlock("latest")
              ).baseFeePerGas.toHexString()
            ),
          }
        : { gasPrice },
      {
        data: !payCoinbase
          ? contract
          : createContract(
              offer,
              maker,
              taker,
              chainId,
              permitData,
              payCoinbaseAmount
            ),
        gasLimit,
        payCoinbaseAmount,
      }
    );
  }

  async createTransaction(txParams: any, sharedAddress: string) {
    const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, data } =
      txParams;

    let sharedAddressBalance = toBigInt(
      await this.signer.provider.getBalance(sharedAddress)
    );
    this.logger.debug(
      `network ${(await this.signer.provider.getNetwork()).chainId}`,
      sharedAddressBalance,
      gasPrice,
      gasLimit
    );
    return Object.assign(new Transaction(), txParams, {
      chainId: (await this.signer.provider.getNetwork()).chainId,
      nonce: await this.signer.provider.getTransactionCount(sharedAddress),
      value: BigInt(0),
    });
  }

  createTrade(peer, offer) {
    return this.createBatchTrade(peer, [
      {
        offer,
        amount: offer.getsAmount,
      },
    ]);
  }
  createBatchTrade(peer, batchFill) {
    const trade = new PintswapTrade();
    trade.hashes = batchFill.map((v) => hashOffer(v.offer));
    this.emit("trade:taker", trade);
    (async () => {
      this.logger.debug(`Acting on offer ${trade.hashes} with peer ${peer}`);
      this.emit("pintswap/trade/taker", 0); // start fulfilling trade
      const { stream } = await this.dialProtocol(peer, [
        "/pintswap/0.1.0/create-trade",
      ]);

      const context1 = await TPC.P1Context.createContext();
      const message1 = context1.step1();
      const messages = pushable();

      /*
       * Pintswap#approveAsMaker
       */
      const self = this;

      pipe(stream.source, lp.decode(), async function (source) {
        try {
          messages.push(
            encodeBatchFill(
              batchFill.map((v) => ({
                offerHash: hashOffer(v.offer),
                amount: v.amount,
              }))
            )
          );
          const offer = ln(sumOffers(ln(batchFill.map((v) => v.offer))));
          messages.push(message1); // message 1
          const { value: keygenMessage2BufList } = await source.next(); // message 2
          const keygenMessage2 = keygenMessage2BufList.slice();
          self.logger.debug(keygenMessage2);
          const { value: makerAddressBufList } = await source.next(); // message 2
          const makerAddress = ethers.getAddress(
            ethers.hexlify(makerAddressBufList.slice())
          );
          self.logger.debug(makerAddress);
          self.logger.debug(
            `TAKER:: /event/ecdsa-keygen/party/1 handling message: 1`
          );
          messages.push(context1.step2(keygenMessage2));
          const keyshareJson = context1.exportKeyShare().toJsonObject();
          const sharedAddress = keyshareToAddress(keyshareJson);
          trade.emit("progress", 1);
          self.emit("pintswap/trade/taker", 1); // taker approving token swap
          // approve as maker
          self.logger.debug(
            `TAKER:: /event/approve-contract approving offer: ${offer} of shared Address ${sharedAddress}`
          );
          const approveTx = await self.approveTradeAsTaker(
            offer,
            sharedAddress as string
          );
          if (!approveTx.permitData)
            await self.signer.provider.waitForTransaction(approveTx.hash);
          self.logger.debug("TAKER APPROVED");
          self.emit("pintswap/trade/taker", 2); // taker approved token swap
          trade.emit("progress", 2);
          self.logger.debug("PUSHING PERMITDATA");
          console.log(approveTx);
          if (approveTx.permitData)
            messages.push(permit.encode(approveTx.permitData));
          else messages.push(Buffer.from([]));
          self.logger.debug("PUSHED PERMITDATA");
          self.logger.debug("SHOULD RECEIVE PERMITDATABYTES");
          const { value: permitDataBytes } = await source.next();
          self.logger.debug("RECEIVED RECEIVE PERMITDATABYTES");
          const permitDataSlice = permitDataBytes.slice();
          const makerPermitData =
            permitDataSlice.length && permit.decode(permitDataSlice);

          self.logger.debug("enter /event/build/tx");
          self.emit("pintswap/trade/taker", 3); // building transaction
          trade.emit("progress", 3);
          self.logger.debug(
            `/event/build/tx funding sharedAddress ${sharedAddress}`
          );
          let contractPermitData = {} as any;
          if (makerPermitData) contractPermitData.maker = makerPermitData;
          if (approveTx.permitData)
            contractPermitData.taker = approveTx.permitData;
          if (!Object.keys(contractPermitData).length)
            contractPermitData = null;
          const txParams = await self.prepareTransaction(
            offer,
            makerAddress,
            sharedAddress,
            contractPermitData
          );
          const payCoinbaseAmount = txParams.payCoinbaseAmount;
          delete txParams.payCoinbaseAmount;
          if (!payCoinbaseAmount) {
            const ethTransaction = await self.signer.sendTransaction({
              to: sharedAddress,
              value: txParams.gasPrice * txParams.gasLimit, // change to gasPrice * gasLimit
            });
            await self.signer.provider.waitForTransaction(ethTransaction.hash);
          }

          self.logger.debug(
            `TAKER:: /event/build/tx building transaction with params: ${offer}, ${await self.signer.getAddress()}, ${sharedAddress}`
          );
          const tx = await self.createTransaction(
            txParams,
            sharedAddress as string
          );

          self.logger.debug(`TAKER:: /event/build/tx built transaction`);

          const _uhash = (tx.unsignedHash as string).slice(2);
          const serialized = Buffer.from(
            ethers.toBeArray(tx.unsignedSerialized)
          );
          const signContext = await TPCsign.P1Context.createContext(
            JSON.stringify(keyshareJson, null, 4),
            new BN(_uhash, 16)
          );

          self.logger.debug(
            `TAKER:: /event/build/tx sending unsigned transaction hash & signing step 1`
          );

          messages.push(serialized);
          messages.push(
            payCoinbaseAmount
              ? Buffer.from(ethers.toBeArray(payCoinbaseAmount))
              : Buffer.from([])
          );
          messages.push(
            Buffer.from(ethers.toBeArray(await self.signer.getAddress()))
          );
          messages.push(signContext.step1());
          self.logger.debug("TAKER: pushed signContext.step1()");
          self.emit("pintswap/trade/taker", 4); // transaction built
          trade.emit("progress", 4);
          self.logger.debug("TAKER: WAITING FOR /event/build/tx");
          self.logger.debug("TAKER: COMPLETED");
          const { value: signMessage_2 } = await source.next();
          self.logger.debug("TAKER: GOT signMessage_2");
          self.logger.debug(
            `TAKER:: /event/ecdsa-sign/party/1 handling message 2`
          );
          messages.push(signContext.step2(signMessage_2.slice()));
          self.logger.debug("TAKER: WAITING FOR /event/ecdsa-sign/party/1");
          self.logger.debug("TAKER: COMPLETED");
          const { value: signMessage_4 } = await source.next();
          self.logger.debug("TAKER: GOT signMessage_4");
          self.logger.debug(
            `TAKER:: /event/ecdsa-sign/party/1 handling message 4`
          );
          signContext.step3(signMessage_4.slice());
          const [r, s, v] = signContext.exportSig();
          tx.signature = ethers.Signature.from({
            r: "0x" + leftZeroPad(r.toString(16), 64),
            s: "0x" + leftZeroPad(s.toString(16), 64),
            v: v + 27,
          });
          let txHash;
          if (
            tx.maxPriorityFeePerGas &&
            ethers.getUint(tx.maxPriorityFeePerGas) === BigInt(0)
          ) {
            txHash = await sendFlashbotsTransaction(tx.serialized);
            console.log(txHash);
          } else {
            txHash = (
              typeof self.signer.provider.sendTransaction == "function"
                ? await self.signer.provider.sendTransaction(tx.serialized)
                : await self.signer.provider.broadcastTransaction(tx.serialized)
            ).hash;
          }
          const txReceipt = await self.signer.provider.waitForTransaction(
            txHash
          );
          self.logger.debug(
            require("util").inspect(txReceipt, {
              colors: true,
              depth: 15,
            })
          );
          messages.end();
          stream.close();
          self.emit("pintswap/trade/taker", 5); // transaction complete
          trade.resolve(txReceipt);
        } catch (e) {
          messages.end();
          stream.close();
          self.logger.error(e);
          trade.reject(e);
        }
      });

      await pipe(messages, lp.encode(), stream.sink);
    })().catch((err) => trade.reject(err));
    return trade;
  }
}
