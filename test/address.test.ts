import assert from 'node:assert/strict';
import test from 'node:test';
import { hasJapaneseAddress } from '../src/address.js';

test('郵便番号の有無や書式に関係なく都道府県と市区町村を照合する', () => {
  for (const prefix of ['', '〒３１０－００１１ ', '3100011 ']) {
    assert.equal(hasJapaneseAddress(`会場: ${prefix}茨城県 水戸市三の丸1-1`), true);
  }
  assert.equal(hasJapaneseAddress('〒310-0011'), false);
  assert.equal(hasJapaneseAddress('茨城県で開催予定'), false);
});
