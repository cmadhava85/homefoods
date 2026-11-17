/**
 * Voice IVR (Exotel / Twilio) — MVP-2+ for seniors who prefer phone.
 * Not wired; channel enum includes VOICE_IVR for future ledger rows.
 */

export type IvrOutboundInput = {
  toMobile: string;
  /** Template / flow id at the IVR vendor */
  flowId: string;
  params?: Record<string, string>;
};

export type IvrCallResult = {
  callId: string;
  status: "QUEUED" | "RINGING" | "COMPLETED" | "FAILED";
};

export interface IvrProvider {
  readonly name: string;
  startOutbound(input: IvrOutboundInput): Promise<IvrCallResult>;
}

export class UnconfiguredIvrProvider implements IvrProvider {
  readonly name = "unconfigured";

  async startOutbound(): Promise<IvrCallResult> {
    throw new Error(
      "IVR is not configured — enable Exotel/Twilio after one pin has stable volume.",
    );
  }
}

let ivrProvider: IvrProvider = new UnconfiguredIvrProvider();

export function getIvrProvider(): IvrProvider {
  return ivrProvider;
}

export function setIvrProvider(provider: IvrProvider) {
  ivrProvider = provider;
}

export function resetIvrProvider() {
  ivrProvider = new UnconfiguredIvrProvider();
}
