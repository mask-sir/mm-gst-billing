// Finance (EMI) and narration rules. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcInvoice, migrateInvoice, cleanSettings, validateInvoice, financeNarration, paymentLabel, ordinal, FINANCE_TEMPLATE, FINANCE_DEFAULTS
} from '../public/js/util.js';

const bill = (extra = {}) => ({
  date: '2026-11-26', customer: { name: 'Ravi' }, items: [{ model: 'Phone', quantity: 1, price: 20000, taxRate: 18 }],
  payment: { mode: 'Cash', received: 4000 }, ...extra
});
const dmi = (amount = 16000) => ({ id: 'dmi', name: 'DMI Finance', amount, emiDay: 3 });

test('finance amount counts as received', () => {
  const t = calcInvoice(bill({ finance: dmi() }));
  assert.equal(t.downPayment, 4000); assert.equal(t.financeAmount, 16000);
  assert.equal(t.received, 20000); assert.equal(t.balance, 0);
});
test('a short finance amount leaves a balance', () => {
  assert.equal(calcInvoice(bill({ finance: dmi(15000) })).balance, 1000);
});
test('down payment is capped at total minus finance', () => {
  const t = calcInvoice(bill({ payment: { mode: 'Cash', received: 20000 }, finance: dmi() }));
  assert.equal(t.downPayment, 4000); assert.equal(t.received, 20000);
});
test('bills without finance are unchanged', () => {
  const t = calcInvoice(bill());
  assert.equal(t.received, 4000); assert.equal(t.balance, 16000); assert.equal(t.financeAmount, 0); assert.equal(t.downPayment, 4000);
});
test('cancelled financed bill counts nothing', () => {
  const t = calcInvoice(bill({ status: 'cancelled', finance: dmi() }));
  assert.equal(t.received, 0); assert.equal(t.balance, 0);
});
test('ordinals for EMI dates', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
});
test('narration template is filled with the bill figures', () => {
  const text = financeNarration(FINANCE_TEMPLATE, bill({ finance: dmi() }));
  assert.match(text, /Financed by DMI Finance\./);
  assert.doesNotMatch(text, /\{/, 'no placeholders left');
  assert.equal(financeNarration('Down ₹{downPayment}, finance ₹{financeAmount} of ₹{total}', bill({ finance: dmi() })), 'Down ₹4,000, finance ₹16,000 of ₹20,000');
  assert.match(text, /before the 3rd of every month/);
  assert.match(text, /Loan \/ agreement no: ______/);
  assert.equal(financeNarration('{unknown} {customer}', bill({ finance: dmi() })), '{unknown} Ravi');
});
test('payment label shows the finance company', () => {
  assert.equal(paymentLabel(bill({ finance: dmi() })), 'Cash + DMI Finance');
  assert.equal(paymentLabel(bill({ finance: dmi(20000), payment: { mode: 'Cash', received: 0 } })), 'DMI Finance (finance)');
  assert.equal(paymentLabel(bill()), 'Cash');
});
test('saved bills keep finance and multi-line narration', () => {
  const m = migrateInvoice(bill({ finance: dmi(), notes: 'line 1\nline 2' }));
  assert.deepEqual(m.finance, dmi()); assert.equal(m.notes, 'line 1\nline 2');
  assert.equal(migrateInvoice(bill()).finance, null);
  assert.equal(migrateInvoice(bill({ finance: { amount: 5 } })).finance, null, 'finance without a company is dropped');
  assert.equal(migrateInvoice(bill({ notes: 'x'.repeat(1500) })).notes.length, 1000);
});
test('settings get the four finance companies by default', () => {
  const s = cleanSettings({ businessName: 'X' });
  assert.deepEqual(s.finances.map(f => f.name), ['DMI Finance', 'Chola', 'Bajaj Finance', 'Axio']);
  assert.deepEqual(FINANCE_DEFAULTS.map(f => f.emiDay), [3, 3, 3, 3]);
  assert.equal(cleanSettings({ finances: [] }).finances.length, 0, 'an emptied list stays empty');
  const two = cleanSettings({ finances: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B', emiDay: 99 }, { name: '' }] }).finances;
  assert.equal(two.length, 2); assert.notEqual(two[0].id, two[1].id); assert.equal(two[1].emiDay, 31);
});
test('validation of financed bills', () => {
  assert.deepEqual(validateInvoice(bill({ finance: dmi() })), []);
  assert.ok(validateInvoice(bill({ finance: dmi(0) })).some(e => /finance amount/.test(e)));
  assert.ok(validateInvoice(bill({ finance: dmi(25000) })).some(e => /more than the bill total/.test(e)));
});
test('edited narration still gets the new EMI date and amounts', async () => {
  const { swapFigures, financeValues } = await import('../public/js/util.js');
  const before = financeValues(bill({ finance: dmi() })), after = financeValues(bill({ payment: { mode: 'Cash', received: 5000 }, finance: { ...dmi(15000), emiDay: 5 } }));
  const text = 'Loan no: DMI-1\nDown ₹4,000, finance ₹16,000. EMI ₹1,780 x 9, before the 3rd of every month. Total 20,000';
  assert.equal(swapFigures(text, before, after), 'Loan no: DMI-1\nDown ₹5,000, finance ₹15,000. EMI ₹1,780 x 9, before the 3rd of every month. Total 20,000'.replace('3rd', '5th'));
  assert.equal(swapFigures('₹4,000 and ₹4,000', before, after), '₹4,000 and ₹4,000', 'ambiguous figure left alone');
  assert.equal(swapFigures('₹14,000', before, after), '₹14,000', 'part of a bigger number is left alone');
  const swapped = financeValues(bill({ payment: { mode: 'Cash', received: 16000 }, finance: dmi(4000) }));
  assert.equal(swapFigures('down 4,000 fin 16,000', before, swapped), 'down 16,000 fin 4,000', 'figures that trade places');
});
