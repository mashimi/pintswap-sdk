import { protocol } from "./protocol";
import { PintP2P } from "./p2p";
import { ethers } from "ethers";
import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import { handleKeygen, initKeygen } from "./utils";
import { TPCEcdsaKeyGen as TPC, TPCEcdsaSign as TPCsign } from "@safeheron/two-party-ecdsa-js";
import { emasm } from "emasm";
import { EventEmitter } from "node:events";
import pushable from "it-pushable";
import BN from "bn.js";

const {
  solidityPackedKeccak256,
  hexlify,
  getAddress,
  getCreateAddress,
  VoidSigner,
  Contract,
  Transaction,
} = ethers;

interface IOffer {
  givesToken: string;
  getsToken: string;
  givesAmount: any;
  getsAmount: any;
}

export const createContract = (offer: IOffer, maker: string, taker: string) => {
  return emasm([
    "pc",
    "returndatasize",
    "0x64",
    "returndatasize",
    "returndatasize",
    getAddress(offer.givesToken),
    "0x23b872dd00000000000000000000000000000000000000000000000000000000",
    "returndatasize",
    "mstore",
    getAddress(maker),
    "0x4",
    "mstore",
    getAddress(taker),
    "0x24",
    "mstore",
    hexlify(offer.givesAmount),
    "0x44",
    "mstore",
    "gas",
    "call",
    "0x0",
    "0x0",
    "0x64",
    "0x0",
    "0x0",
    getAddress(offer.getsToken),
    getAddress(taker),
    "0x4",
    "mstore",
    getAddress(maker),
    "0x24",
    "mstore",
    hexlify(offer.getsAmount),
    "0x44",
    "mstore",
    "gas",
    "call",
    "and",
    "failure",
    "jumpi",
    getAddress(maker),
    "selfdestruct",
    ["failure", ["0x0", "0x0", "revert"]],
  ]);
};

export const hashOffer = (o) => {
  return solidityPackedKeccak256(
    ["address", "address", "uint256", "uint256"],
    [
      getAddress(o.givesToken),
      getAddress(o.getsToken),
      o.givesAmount,
      o.getsAmount,
    ]
  );
};

function keyshareToAddress (keyshareJsonObject) {
  let { Q } = keyshareJsonObject as any;
  let prepend = new BN(Q.y, 16).mod(new BN(2)).isZero() ? "0x02" : "0x03";
  let derivedPubKey = prepend + new BN(Q.x, 16).toString(16);
  return ethers.computeAddress(derivedPubKey); 
}

export class Pintswap extends PintP2P {
  public signer: any;
  public offers: Map<string, IOffer> = new Map();
  // public offers: IOffer[];

  static async initialize({ signer }) {
    let peerId = await this.peerIdFromSeed(await signer.getAddress());
    const self = new this({ signer, peerId });

    await self.handle("/pintswap/0.1.0/orders", (duplex) =>
      pipe(
        duplex.stream.sink,
        lp.encode(),
        protocol.OfferList.encode({ offers: self.offers.values() })
      )
    );

    await self.handle(
      "/pintswap/0.1.0/create-trade",
      async ({ stream, connection, protocol }) => {
          let context2 = await TPC.P2Context.createContext();
          let messages = pushable();
          let _event = new EventEmitter();
          let sharedAddress = null;
          let keyshareJson = null;
          let signContext = null;

          _event.on('/internal/ecdsa/party2/inbound/msg/1', (message) => {
            messages.push(
              context2.step1(message)
            );
          })

          _event.on('/internal/ecdsa/party2/inbound/msg/3', (message) => {
            context2.step2(message)

            keyshareJson = context2.exportKeyShare().toJsonObject();
            sharedAddress = keyshareToAddress(keyshareJson);
          })

          _event.on('/pintswap/ecdsa/party2/unsigned-hash', async (message) => {
            let [ uHash, step1 ] = message;
            signContext = await TPCsign.P2Context.createContext(
              JSON.stringify(keyshareJson, null, 4), 
              new BN(uHash.toString(), 16)
            );
            messages.push(
              signContext.step1(step1)
            );
          })

          _event.on('/pintswap/ecdsa/party2/sign/msg/3', (message) => {
            messages.push(
              signContext.step2(message)
            );
          })


          pipe(
            stream.source,
            lp.decode(),
            async function (source) {
              const { value: message1 } = await source.next();
              _event.emit('/internal/ecdsa/party2/inbound/msg/1', message1.slice());
              const { value: message3 } = await source.next();
              _event.emit('/internal/ecdsa/party2/inbound/msg/3', message3.slice());
              const { value: unsignedHash } = await source.next();
              const { value: signMessage1 } = await source.next();
              _event.emit('/pintswap/ecdsa/party2/unsigned-hash', [unsignedHash.slice(), signMessage1.slice()]);
              const { value: signMessage3 } = await source.next();
              _event.emit('/pintswap/ecdsa/party2/sign/msg/3', signMessage3.slice());
            }
          )

          await pipe(
            messages,
            lp.encode(),
            stream.sink
          )
      },
    );
    await self.start();
    return self;
  }

  constructor({ signer, peerId }) {
    super({ signer, peerId });
    this.signer = signer;
  }

  // adds new offer to this.offers: Map<hash, IOffer>
  listNewOffer(_offer: IOffer) {
    this.offers.set(hashOffer(_offer), _offer);
  }

  async getTradeAddress(sharedAddress: string) {
    return getCreateAddress({
      nonce: await this.signer.provider.getTransactionCount(sharedAddress), 
      from: sharedAddress, 
    });
  }
  async approveTradeAsMaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    return await new Contract(
      offer.givesToken,
      ["function approve(address, uint256) returns (bool)"],
      this.signer
    ).approve(tradeAddress, offer.givesAmount);
  }
  async approveTradeAsTaker(offer: IOffer, sharedAddress: string) {
    const tradeAddress = await this.getTradeAddress(sharedAddress);
    return await new Contract(
      getAddress(offer.getsToken),
      ["function approve(address, uint256) returns (bool)"],
      this.signer
    ).approve(tradeAddress, offer.getsAmount);
  }
  async createTransaction(offer: IOffer, maker: string, sharedAddress: string) {
    const contract = createContract(
      offer,
      maker,
      await this.signer.getAddress()
    );
    const gasPrice = ethers.toBigInt(await this.signer.provider.send('eth_gasPrice', []));
    const gasLimit = await this.signer.provider.estimateGas({
      data: contract,
      from: sharedAddress,
      gasPrice,
    });
    return Object.assign(new Transaction(), {
      data: createContract(offer, maker, await this.signer.getAddress()),
      chainId: (await this.signer.provider.getNetwork()).chainId,
      gasPrice,
      gasLimit,
      nonce: await this.signer.provider.getTransactionCount(sharedAddress),
      value: await this.signer.provider.getBalance >= ( gasPrice * gasLimit ) ? (await this.signer.provider.getBalance(sharedAddress)) - ( gasPrice * gasLimit ) : BigInt(0), // check: balance >= ( gasPrice * gasLimit ) | resolves ( balance - (gasPrice * gasLimit) ) or 0
    });
  }

  async createTrade(peer, offer) {
    console.log( 
      `Acting on offer ${ offer } with peer ${ peer }`
    );
  
    let { stream } = await this.dialProtocol(peer, [
      "/pintswap/0.1.0/create-trade",
    ]);

    let _event = new EventEmitter();
    let context1 = await TPC.P1Context.createContext();
    let signContext = null;
    const message1 = context1.step1(); 
    const messages = pushable(); 
    let tx = null;
    let sharedAddress = null;
    let keyshareJson = null;

    _event.on('/internal/ecdsa-keygen/party/2/status/step1', () => {
      let _message1 = context1.step1();
      console.log(
        `step 1 with message`
      );
      messages.push(_message1);
    })

    // get keygen message 2 
    // generate keyshare and shared address as well as transaction
    _event.on('/internal/ecdsa/party1/inbound/msg/2', async (message) => {
      messages.push(
        context1.step2(message)
      );
      keyshareJson = context1.exportKeyShare().toJsonObject();
      sharedAddress = keyshareToAddress(keyshareJson);

      //TODO: extract fund transaction logic to a class method
      let _fundTx = {
        to: sharedAddress,
        value: ethers.parseEther("0.02")
      }
      let fundResponse = await this.signer.sendTransaction(_fundTx);
      // ----- 

      tx = await this.createTransaction(
        offer,
        await this.signer.getAddress(),
        sharedAddress as string
      );

      // convert unsignedHash to a Buffer for wire 
      let _uhash = (tx.unsignedHash as string).slice(2)

      signContext = await TPCsign.P1Context.createContext(
        JSON.stringify(keyshareJson, null, 4), 
        new BN(_uhash, 16)
      ) 

      messages.push(
        Buffer.from(_uhash)
      )
      messages.push(
        signContext.step1()
      )
    });

    // preform sign step2 with message 2
    _event.on('/internal/ecdsa/party1/sign/msg/2', (message) => {
      messages.push(
        signContext.step2(message)
      )
    });
  
    // get message 4 and generate a Signature { r, s, v } to sign tx
    _event.on('/internal/ecdsa/party1/sign/msg/4', async (message) => {
      signContext.step3(message)
      let [r, s, v] = signContext.exportSig();
      let signature = ethers.Signature.from({ 
        r: '0x' + r.toString(16),
        s: '0x' + s.toString(16),
        v: v + 27
      });

      // make tx a signed transaction
      tx.signature = signature;
      let response = await this.signer.provider.broadcastTransaction(tx.serialized);
      console.log(await response.wait());
    });

    pipe(
      stream.source,
      lp.decode(),
      async function (source) {
        messages.push(message1);
        const { value: message2 } = await source.next();
        _event.emit('/internal/ecdsa/party1/inbound/msg/2', message2.slice());
        const { value: signMessage2 } = await source.next();
        _event.emit('/internal/ecdsa/party1/sign/msg/2', signMessage2.slice());
        const { value: signMessage4 } = await source.next();
        _event.emit('/internal/ecdsa/party1/sign/msg/4', signMessage4.slice());
      }
    )
    await pipe(
      messages,
      lp.encode(),
      stream.sink
    )

  }

}
