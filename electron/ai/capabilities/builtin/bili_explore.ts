// 内置能力：bili_explore（桌宠端侧）—— 与 kirari-core 同名能力语义对等。
// 两端在网络能力上对等：桌宠端一样能逛B站、互动、管开关、查闲时活动；
// 核心版只是少了桌宠外壳。共享同一扩展包（com.akisaki.bili.explore）。
import { defineCapability, type Capability } from "kirari-agent";
import { getService } from "../../../extensions/host";
import * as db from "../../db/storage";
import { remember } from "../../services/memory";

const SERVICE_ID = "bili.explore";
const KEY = "bili_interaction";
const DEFAULTS = { enabled: false, autoBrowse: false, comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false };
const CHANNELS: Record<string, string> = { enabled: '总开关', autoBrowse: '自主闲逛', comment: '评论', dynamic: '动态', dm: '私信', like: '点赞', coin: '投币', favorite: '收藏' };

type Settings = typeof DEFAULTS;
function readSettings(): Settings {
  try {
    const row = db.getDb().prepare('SELECT value FROM settings_kv WHERE key = ?').get(KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULTS };
    const v = JSON.parse(row.value);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) out[k] = !!v[k];
    return out;
  } catch { return { ...DEFAULTS }; }
}
function writeSettings(next: Settings): Settings {
  const v: any = {}; for (const k of Object.keys(DEFAULTS)) v[k] = !!(next as any)[k];
  db.getDb().prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(v));
  return v as Settings;
}
function fullMeta(v: any) {
  const bvid = String(v?.bvid || '');
  return { bvid, url: bvid ? 'https://www.bilibili.com/video/' + bvid : '', title: String(v?.title || ''), category: String(v?.category || v?.tname || '') };
}
// 活动状态键（与核心端共库同键）
const ACT_KEY = (uid: number | string) => 'current_activity:' + uid;
function activityStart(name: string, uid: any) {
  try { db.getDb().prepare('INSERT INTO settings_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(ACT_KEY(uid), JSON.stringify({ name, startedAt: Date.now() })); } catch {}
}
function activityClear(uid: any) { try { db.getDb().prepare('DELETE FROM settings_kv WHERE key=?').run(ACT_KEY(uid)); } catch {} }
function activityGet(uid: any): any {
  try { const row = db.getDb().prepare('SELECT value FROM settings_kv WHERE key=?').get(ACT_KEY(uid)) as {value?:string}|undefined; return row?.value ? JSON.parse(row.value) : null; } catch { return null; }
}

const capability: Capability = defineCapability({
  id: 'bili_explore', name: 'bili_explore', kind: 'tool', scope: 'builtin',
  description:
    '让她自己去 B 站逛逛（只读）+ 管理互动开关，与核心版能力对等。' +
    '只读：popular/search/discover（自主发现，优先用她登录号的推荐流）/opus/liveInfo/liveList/musicSearch/subtitles/comments/扫码登录。' +
    '互动：like/coin/favorite/comment（视频）与 opusLike/opusCoin/opusFavorite（专栏），需开关+登录。' +
    'B站是公开环境，公开输出只谈当前话题、只表达态度，不引用记忆、不透露看过什么；主人私聊可看BV号/链接/标题。' +
    'settings 查六开关（默认全关）；setInteraction 改开关必须二次确认（先不带confirm问，用户说「确认」再带confirm=true）。' +
    '刷B站是低优先级闲时活动，可被打断；问「你在干嘛」能如实回答；activity 可查/停。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['popular','search','explore','discover','settings','setInteraction','activity','subtitles','comments','opus','liveInfo','liveList','musicSearch','loginStatus','qrGenerate','qrPoll','logout','like','coin','favorite','comment','opusLike','opusCoin','opusFavorite','reviewList','reviewDecide'], description: '动作。' },
      keyword: { type: 'string' }, count: { type: 'number' }, takeaway: { type: 'string' },
      bvid: { type: 'string' }, opusId: { type: 'string' }, roomId: { type: 'number' }, text: { type: 'string' },
      reviewId: { type: 'string' }, approve: { type: 'boolean' },
      channel: { type: 'string', enum: Object.keys(CHANNELS) }, enabled: { type: 'boolean' }, confirm: { type: 'boolean' }, stop: { type: 'boolean' },
    },
    required: ['action'],
  },
  tags: ['builtin', 'bili'], timeoutMs: 30000,
});

async function dispatch(args: any, ctx: any): Promise<any> {
  const a = args || {}; const action = String(a.action || '');
  const bs = readSettings();
  // 总闸：B站功能关掉后，除查看/修改开关外一律拒绝
  if (!bs.enabled && !['settings', 'setInteraction'].includes(action)) {
    return { ok: false, disabled: true, error: 'B站功能总开关已关闭。要让我去B站，先说「开启B站」（需确认）。' };
  }
  const uid = ctx?.uid ?? 1;
  const svc: any = getService(SERVICE_ID);
  if (!svc) return { ok: false, error: 'B站扩展包未安装或未加载（两端共用）' };

  if (action === 'popular') return { ok: true, audience: 'owner', videos: ((await svc.popular({ count: Number(a.count) || 5 })) || []).map(fullMeta) };
  if (action === 'search') return { ok: true, audience: 'owner', videos: ((await svc.search({ keyword: String(a.keyword || ''), page: 1 })) || []).map(fullMeta) };
  if (action === 'musicSearch') return { ok: true, audience: 'owner', videos: ((await svc.musicSearch({ keyword: String(a.keyword || ''), page: 1 })) || []).map(fullMeta) };
  if (action === 'opus') return { ok: true, article: await svc.opus(String(a.opusId || '')) };
  if (action === 'liveInfo') return { ok: true, info: await svc.liveInfo({ roomId: Number(a.roomId) || 0 }) };
  if (action === 'liveList') return { ok: true, list: await svc.liveList({ count: Number(a.count) || 10 }) };
  if (action === 'subtitles') return { ok: true, list: await svc.subtitles({ bvid: String(a.bvid || '') }) };
  if (action === 'comments') return { ok: true, list: await svc.comments({ bvid: String(a.bvid || ''), count: 20 }) };
  if (action === 'loginStatus') return { ok: true, ...(await svc.loginStatus()) };
  if (action === 'qrGenerate') return { ok: true, ...(await svc.qrGenerate()) };
  if (action === 'qrPoll') return { ok: true, ...(await svc.qrPoll()) };
  if (action === 'logout') return { ok: true, ...(await svc.logout()) };

  if (action === 'settings') return { ok: true, ...readSettings() };
  if (action === 'setInteraction') {
    const ch = String(a.channel || '');
    if (!CHANNELS[ch]) return { ok: false, error: '未知开关: ' + ch };
    if (a.confirm !== true) return { ok: false, needConfirm: true, message: '确定' + (a.enabled ? '开启' : '关闭') + 'B站' + CHANNELS[ch] + '？请回复「确认」生效。' };
    const next = { ...readSettings(), [ch]: !!a.enabled }; writeSettings(next);
    return { ok: true, settings: next, message: 'B站' + CHANNELS[ch] + '已' + (a.enabled ? '开启' : '关闭') + '，设置界面已同步' };
  }
  if (action === 'activity') {
    if (a.stop === true) { activityClear(uid); return { ok: true, activity: null }; }
    return { ok: true, activity: activityGet(uid) };
  }

  if (action === 'reviewList') return { ok: true, pending: await svc.listPending() };
  if (action === 'reviewDecide') return { ok: true, ...(await svc.decide({ id: String(a.reviewId||a.id||''), approve: !!a.approve })) };

  const writeMap: Record<string,string> = { like:'like', coin:'coin', favorite:'favorite', comment:'comment', opusLike:'like', opusCoin:'coin', opusFavorite:'favorite' };
  if (writeMap[action]) {
    if (!readSettings()[writeMap[action] as keyof Settings]) return { ok: false, error: 'B站' + CHANNELS[writeMap[action]] + '未开启，请在设置或命令里开启（需确认）' };
    if (action === 'comment') { const rel = await svc.isRelevantComment({ comment: String(a.text||''), topic: '' }); if (!rel.relevant) return { ok:false, error:'评论须围绕当前话题、禁引流私信' }; }
    if (action.startsWith('opus')) return { ok: true, ...(await svc[action]({ opusId: String(a.opusId||'') })) };
    return { ok: true, ...(await svc[action]({ bvid: String(a.bvid||''), text: String(a.text||''), num: Number(a.num)||1 })) };
  }

  if (action === 'discover' || action === 'explore') {
    if (a.fromSchedule === true && !bs.autoBrowse) return { ok: false, disabled: true, error: '自主闲逛已关闭（autoBrowse=false）' };
    activityStart('刷B站', uid);
    try {
      let knownPersons: string[] = [];
      try { const rows = await db.listPeople(); knownPersons = (rows||[]).filter((p:any)=>p&&['owner','family','friend'].includes(p.role)).flatMap((p:any)=>[p.displayName,p.alias,p.personKey].filter(Boolean).map(String)).filter((x:string)=>x.length>=2); } catch {}
      const result: any = action === 'discover'
        ? await svc.discover({ seenBvids: a.seenBvids || [], count: Number(a.count) || 3, knownPersons })
        : await svc.explore({ keyword: String(a.keyword||''), takeaway: String(a.takeaway||''), knownPersons });
      const written: any[] = [];
      for (const ob of (result.observations || [])) {
        const check = await svc.isSafeBiliMemory({ text: ob.text || '', knownPersons });
        if (!check.safe) continue;
        const r = await remember({ content: '[B站见闻·只谈自己的感受] ' + ob.text, scope: 'self', source: 'observed', kind: 'event', visibility: 'private', importance: 3 }, ctx);
        if (r?.ok) written.push({ id: r.id, text: ob.text });
      }
      return { ok: true, audience: 'owner', personalized: result.personalized, videos: (result.videos||[]).map((v:any)=>({...fullMeta(v), score: v.score})), written };
    } finally { activityClear(uid); }
  }

  return { ok: false, error: '未知 action: ' + action };
}

export { capability, dispatch };
