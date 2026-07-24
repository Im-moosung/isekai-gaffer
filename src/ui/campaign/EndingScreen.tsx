import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'
import './campaign.css'

/** 라운드별 엔딩 헤드라인 — 사실 서술형. 실존 인물·팀 비하 금지. */
function headlineFor(reached: CampaignStage, champion: boolean): { title: string; body: string } {
  if (champion) {
    return {
      title: '세계를 제패하다',
      body: '대한민국, 월드컵 정상에 올랐다. 조별리그부터 결승까지 이어진 완주의 끝에서 이룬 위대한 성취.',
    }
  }
  switch (reached) {
    case 'final':
      return {
        title: '준우승, 위대한 여정',
        body: '결승에서 아쉽게 멈췄지만, 세계 무대 정상을 눈앞에 둔 역사에 남을 여정이었다.',
      }
    case 'sf':
      return {
        title: '4강 진출, 세계 4위',
        body: '준결승 무대까지 오르며 세계 네 팀 안에 이름을 올린 값진 대회였다.',
      }
    case 'qf':
      return {
        title: '8강 진출',
        body: '아시아를 넘어 세계 강호들과 어깨를 나란히 한 대회, 8강에서 여정을 마쳤다.',
      }
    case 'r16':
      return {
        title: '16강 진출',
        body: '조별리그를 통과해 토너먼트 무대에서 당당히 겨룬 대회였다.',
      }
    case 'r32':
      return {
        title: '32강 진출',
        body: '조별리그를 넘어 토너먼트에 올랐다. 다음을 기약하는 경험이 된 대회.',
      }
    case 'group3':
    default:
      return {
        title: '실제 역사와 같은 결말 — 조별리그 탈락',
        body: '조별리그에서 여정을 마쳤다. 아쉬움을 뒤로하고 다음 대회를 준비한다.',
      }
  }
}

interface Tally { w: number; d: number; l: number; gf: number; ga: number }

function tally(records: MatchRecord[]): Tally {
  const t: Tally = { w: 0, d: 0, l: 0, gf: 0, ga: 0 }
  for (const r of records) {
    const [a, b] = r.score
    t.gf += a
    t.ga += b
    if (a > b) t.w++
    else if (a < b) t.l++
    else if (r.shootout) (r.shootout[0] > r.shootout[1] ? t.w++ : t.l++)
    else t.d++
  }
  return t
}

/** 캠페인 엔딩 화면 — campaignStore.ending 기반 헤드라인 + 기록 요약 + [처음부터]. */
export function EndingScreen({ onRestart }: { onRestart(): void }) {
  const ending = useCampaignStore(s => s.ending)
  const records = useCampaignStore(s => s.records)

  if (!ending) return null

  const { title, body } = headlineFor(ending.reached, ending.champion)
  const t = tally(records)
  const diff = t.gf - t.ga
  const diffLabel = diff > 0 ? `+${diff}` : `${diff}`

  return (
    <div className={`end-root${ending.champion ? ' end-root--champion' : ''}`}>
      <div className="end-card">
        <h1 className="end-headline">{title}</h1>
        <p className="end-body">{body}</p>

        <dl className="end-summary" aria-label="기록 요약">
          <div className="end-summary__item">
            <dt>전적</dt>
            <dd>{t.w}승 {t.d}무 {t.l}패</dd>
          </div>
          <div className="end-summary__item">
            <dt>득실</dt>
            <dd>{t.gf}득점 {t.ga}실점 ({diffLabel})</dd>
          </div>
        </dl>

        <button type="button" className="end-restart" onClick={onRestart}>
          처음부터
        </button>
      </div>
    </div>
  )
}
