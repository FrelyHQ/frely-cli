import test from "node:test";
import assert from "node:assert/strict";
import { machineFingerprint } from "./machine-id.js";
import { sameComputerNotes } from "./control.js";

test("the machine fingerprint is a salted hash that differs per account", () => {
  const id = "4C4C4544-0042-3510-8051-B4C04F4E4A32";
  const a = machineFingerprint(id, "usr_a");
  assert.match(a, /^[0-9a-f]{64}$/u);
  assert.equal(machineFingerprint(id.toLowerCase(), "usr_a"), a);
  assert.notEqual(machineFingerprint(id, "usr_b"), a);
  assert.ok(!a.includes(id.toLowerCase().replace(/-/gu, "")));
});

test("enrollment notes name replaced and still-connected entries of this computer", () => {
  assert.deepEqual(sameComputerNotes({ deviceId: "drd_x" }), []);
  const notes = sameComputerNotes({ replaced: [{ deviceId: "drd_a", name: "Office Mac" }], sameComputerOnline: [{ deviceId: "drd_b", name: "mbp" }, { bad: 1 }] });
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /registered before as "Office Mac"/u);
  assert.match(notes[1]!, /^Warning: another Frely on this computer is connected as "mbp"/u);
});
