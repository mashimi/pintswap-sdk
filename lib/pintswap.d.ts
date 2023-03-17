import type { BytesLike } from "@ethersproject/bytes";
import type { BigNumberish } from "@ethersproject/bignumber";
interface IOffer {
    givesToken: BytesLike;
    getsToken: BytesLike;
    givesAmount: BigNumberish;
    getsAmount: BigNumberish;
}
export declare const createContractAsTaker: (offer: IOffer, maker: string, taker: string) => any;
export declare const hashOffer: (o: any) => any;
export {};
