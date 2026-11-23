const japaneseAddress =
  /(?:北海道|東京都|大阪府|京都府|[一-龯]{2,3}県)[ \t]*[一-龯ぁ-んァ-ヶ]{1,16}[市区町村]/u;
export function hasJapaneseAddress(text: string) {
  return japaneseAddress.test(text.normalize('NFKC'));
}
