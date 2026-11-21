import type { CollectedMail } from './domain/mail.js';
import { modelText, unwrapForward } from './ollama.js';

const bulk = /unsubscribe|配信停止|配信解除|登録解除|メールマガジン|メルマガ|newsletter/i;
const promotional =
  /\b(?:sale|save up to|discount|coupon|special offer|promo code|black friday|cyber monday)\b|(?:\d+\s*%|\d+\s*円)\s*off|セール|割引|クーポン|特価|ポイント還元|ポイント.*(?:当たる|もらえる)|お買い得|キャンペーン|ブラックフライデー|クーポンコード|先行価格|返礼品が/i;
const roundup =
  /メルマガ|メールマガジン|ニュースレター|ニュースまとめ|(?:今週|今月|本日)の新着|新着\d+件|週刊|weekly digest|newsletter|roundup/i;
const recruitment =
  /参加募集|参加者募集|募集中|申[し込込み]*受付中|募集開始|募集終了|open for registration|register now|registration is open/i;
const commitment =
  /日程(?:調整)?が確定|お?申[し込込み]*が完了|お?申[し込込み]*を受け付けました|参加(?:が)?確定|ご?予約(?:が|を)?(?:確定|完了)|ご予約確認書|受け?取り準備が完了|受取準備が完了|発券(?:済|しました)|旅程表|(?:予約|注文|受付)(?:番号|ID)\s*[:：#]?\s*[A-Z0-9-]{5,}\b|(?:your (?:booking|appointment|registration)|booking reference|order number|order confirmation|reservation confirmed|ticket issued)/i;

export function optionalMailExclusion(mail: CollectedMail): string | undefined {
  if (mail.calendarParts.length) return;
  const subject = unwrapForward(mail).subject.normalize('NFKC');
  const hasPromotion = promotional.test(subject);
  const isRoundup = roundup.test(subject);
  const isRecruitment = recruitment.test(subject);
  if (!hasPromotion && !isRoundup && !isRecruitment) return;

  const distributed = bulk.test(mail.text + '\n' + subject);
  const text = modelText(mail).normalize('NFKC');
  // Check the start of the notification for evidence of an existing commitment,
  // before boilerplate such as instructions for hypothetical orders.
  if (commitment.test(subject + '\n' + text.slice(0, 2200))) return;

  if (
    hasPromotion &&
    (distributed || text.split(/\n\s*\n/).filter((part) => promotional.test(part)).length >= 2)
  )
    return 'セール・割引などの販促案内';
  if (distributed && isRoundup) return '一斉配信の新着まとめ・一般案内';
  if (distributed && isRecruitment) return '未申込者向けの募集案内';
}
