import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtMoney, pickAmount } from "./handler.js";

describe("fmtMoney", () => {
  it("formats UF values with thousands and decimals", () => {
    const formatted = fmtMoney(123456.789, "uf");
    assert.strictEqual(formatted, "UF 123.456,79");
  });
});

describe("pickAmount", () => {
  it("prefers explicit reservation price before falling back to property price", () => {
    const payload = {
      precio_reserva: "250000",
      accion: { precioUnitario: "50000", cantidad: 10 },
      property: { price: 700000 },
    };

    assert.strictEqual(pickAmount(payload), 250000);
  });
});
