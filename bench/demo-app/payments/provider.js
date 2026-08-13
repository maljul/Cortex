// PAYMENTS — the dead end.
//
// Refunds are manual because the provider's v3 API is not available on this account. A1 is
// the ticket that tries to migrate onto it and abandons; the eleventh ticket is a second
// agent asked to move the refund flow onto the same API.
//
// **Nothing in this file is ever patched, and that is interlock 5.** The difference between
// the two lanes is not a line of code — it is whether the second agent spends its budget
// discovering what the first one already found out. A file diff cannot show that; the
// journey and the token meter can.

function providerApiVersion() {
  return 2;
}

function refund(order) {
  return {
    ok: false,
    reason: 'refunds are manual until the provider migration lands',
  };
}
