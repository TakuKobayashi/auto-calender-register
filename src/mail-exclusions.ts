import type { CollectedMail } from './domain/mail.js';
import { modelText, unwrapForward } from './ollama.js';

const exclusionPatterns = {
  sales:
    /セール|全品割引|(?:期間|数量)限定(?:価格|割引|特価)|特別価格で|今だけお得|(?:おトク|お得)が盛りだくさん|\d+(?:\.\d+)?\s*%\s*(?:off|割引)|\b(?:flash sale|clearance sale|black friday|cyber monday)\b/i,
  coupons:
    /クーポン(?:を)?(?:配布|プレゼント|取得|獲得)|クーポンコード|クーポン付(?:き)?|\b(?:promo code|claim your coupon|coupon code)\b/i,
  campaigns:
    /キャンペーン(?:のご案内|開催中|に参加|に応募)|抽選で(?:当|あ)たる|賞品プレゼント|\b(?:enter to win|chance to win|giveaway)\b/i,
  recommendations:
    /おすすめ(?:の|する)?(?:商品|航空券|ホテル|イベント|プラン)|旅行.{0,15}お得情報|あなたに(?:ぴったり|ピッタリ)|\b(?:picked for you|recommended deals|last chance to save)\b/i,
  optOut: /配信停止(?!中)|配信解除|配信設定|\bunsubscribe\b/i,
  marketingMail:
    /メールマガジン|メルマガ|ニュースレター|ニュースまとめ|最新情報をお届け|\b(?:newsletter|news roundup)\b/i,
  newPurchase:
    /(?:今すぐ|お早めに).{0,12}(?:予約|購入|注文)|(?:予約|購入|注文)を完了しましょう|ご購入はこちら|無料トライアル|\b(?:buy now|shop now|complete your (?:booking|purchase|order)|start (?:your|a) free trial)\b/i,
  publicEvents:
    /参加者募集|一般参加者?募集|どなたでも.{0,12}(?:参加|応募)|スタンプラリー.{0,16}(?:開催|実施)(?:中|します)|\b(?:open to the public|open for registration|limited spots)\b/i,
  promotions:
    /先行販売|予約受付開始|ボーナスポイント獲得のチャンス|期間限定アーカイブ配信|\b(?:now on sale|view offers)\b/i,
  articles:
    /(?:記事|動画)を(?:見る|読む|ご覧)|(?:基本|具体策|仕組み|使い方|ルール)を解説|\b(?:read the article|watch now)\b/i,
};

export function filterCalendarMails(
  mails: readonly CollectedMail[],
  onError?: (mail: CollectedMail, error: unknown) => void,
): CollectedMail[] {
  const patterns = Object.values(exclusionPatterns);
  return mails.filter((mail) => {
    try {
      if (mail.calendarParts.length) return true;
      const text = (unwrapForward(mail).subject + '\n' + modelText(mail))
        .normalize('NFKC')
        .replace(/\p{Cf}/gu, '');
      return !patterns.some((pattern) => pattern.test(text));
    } catch (error) {
      if (!onError) throw error;
      onError(mail, error);
      return false;
    }
  });
}
