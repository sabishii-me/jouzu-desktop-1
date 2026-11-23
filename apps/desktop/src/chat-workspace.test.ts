import { describe, expect, it } from "vitest";
import { composerTurn } from "./composer-state";

describe("composer turn phase mapping", () => {
  const turn = (phase: string) => ({ turnId: "turn-1", phase });

  it("offers Stop but not Steer while the turn's runtime is starting", () => {
    expect(composerTurn(turn("starting"), true, false)).toEqual({ stop: true, steer: false, sending: false });
  });

  it("keeps Send and Stop for a message on its way while the runtime starts", () => {
    expect(composerTurn(turn("starting"), true, true)).toEqual({ stop: true, steer: false, sending: true });
  });

  it("allows steering once the host reports a running turn", () => {
    expect(composerTurn(turn("running"), true, false)).toEqual({ stop: true, steer: true, sending: false });
  });

  it("uses the projection fallback when no active turn exists", () => {
    expect(composerTurn(undefined, false, false)).toEqual({ stop: false, steer: false, sending: false });
    expect(composerTurn(undefined, true, false)).toEqual({ stop: true, steer: true, sending: false });
    expect(composerTurn(undefined, false, true)).toEqual({ stop: true, steer: false, sending: true });
  });
});
