import type { Player, Position } from '../../engine/types'
import type { PlayerMatchStats } from '../../game/playerStats'
import './PlayerCard.css'

/** 레이더 한 축 — 표시 라벨 + 값(1~99). */
export interface RadarAxis { key: string; label: string; value: number }

/** 필드 선수 6축(슈팅/패스/드리블/수비/피지컬/스피드) — 순서 = 육각 시계방향(top→). */
export const FIELD_AXES: { key: keyof NonNullable<Player['stats']>; label: string }[] = [
  { key: 'shooting', label: '슈팅' },
  { key: 'passing', label: '패스' },
  { key: 'dribbling', label: '드리블' },
  { key: 'defending', label: '수비' },
  { key: 'physical', label: '피지컬' },
  { key: 'pace', label: '스피드' },
]
/** GK 3축(선방/공중/빌드업) — 삼각 변형. */
export const GK_AXES: { key: keyof NonNullable<Player['gkStats']>; label: string }[] = [
  { key: 'saving', label: '선방' },
  { key: 'aerial', label: '공중' },
  { key: 'buildup', label: '빌드업' },
]

/** 스탯 최대값(정규화 기준). 스탯은 1~99 → 99에서 반지름 100%. */
export const STAT_MAX = 99

/** 선수의 레이더 축 목록을 반환한다(GK면 3축, 아니면 6축). 스탯 미보유 시 빈 배열. */
export function playerAxes(player: Player): RadarAxis[] {
  if (player.gkStats) {
    return GK_AXES.map(a => ({ key: a.key, label: a.label, value: player.gkStats![a.key] }))
  }
  if (player.stats) {
    return FIELD_AXES.map(a => ({ key: a.key, label: a.label, value: player.stats![a.key] }))
  }
  return []
}

export interface RadarGeo { cx: number; cy: number; r: number; max?: number }

/**
 * 레이더 폴리곤 꼭짓점 좌표를 계산한다(순수).
 * 축 0을 12시(위)에 두고 시계방향으로 등각 배치, 값/max 비율로 반지름을 스케일.
 * i번째 각도 = -90° + i·(360/n).
 */
export function radarPoints(values: number[], geo: RadarGeo): { x: number; y: number }[] {
  const n = values.length
  const max = geo.max ?? STAT_MAX
  return values.map((v, i) => {
    const ratio = Math.max(0, Math.min(1, v / max))
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return {
      x: geo.cx + geo.r * ratio * Math.cos(angle),
      y: geo.cy + geo.r * ratio * Math.sin(angle),
    }
  })
}

/** 축 라벨/그리드 앵커 좌표(값 무관, 100% 반지름 위치). */
function axisAnchors(n: number, geo: RadarGeo): { x: number; y: number }[] {
  return radarPoints(new Array(n).fill(geo.max ?? STAT_MAX), geo)
}

const ptsAttr = (pts: { x: number; y: number }[]) =>
  pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')

const FOOT_LABEL: Record<'L' | 'R' | 'B', { short: string; label: string }> = {
  L: { short: 'L', label: '왼발' },
  R: { short: 'R', label: '오른발' },
  B: { short: '양', label: '양발' },
}

/** 아바타 이니셜 — 한글 이름 우선(첫 글자), 없으면 영문 이니셜 최대 2자. */
export function avatarInitials(player: Player): string {
  const ko = player.name.ko?.trim()
  if (ko) {
    // 한글은 첫 글자, 라틴은 첫 두 토큰 이니셜.
    if (/[가-힣]/.test(ko)) return ko[0]
  }
  const en = (player.name.en || ko || '').trim()
  const parts = en.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return '?'
}

interface PlayerCardProps {
  player: Player
  /** 'full'(기본, 축 라벨·게이지) | 'compact'(작은 레이더·요약). */
  size?: 'compact' | 'full'
  /** 아바타 배경 팀 컬러. */
  side?: 'home' | 'away'
  /** 표시 포지션(라인업 슬롯). 미지정 시 player.position. */
  slot?: Position
  /** 역할 라벨(전술 역할 — 자리만 확보, 옵션). */
  role?: string
  /** 실시간 체력 0~100(옵션 — 있을 때만 게이지 표시). */
  stamina?: number
  /** 실시간 사기 0~100(옵션). */
  morale?: number
  /** 이 경기 개인 기록(옵션 — 경기 중에만 준다. 킥오프 전엔 데이터가 없으므로 미지정). */
  matchStats?: PlayerMatchStats
  /** 키 플레이어 강조(★). */
  star?: boolean
}

/** 재사용 선수 카드 — 이니셜 아바타 + 이름·번호·포지션(+역할) + 육각/삼각 레이더 SVG
 *  + 주발 아이콘 + 체력·사기 게이지(값 제공 시) + 이 경기 개인 기록(값 제공 시).
 *  어디서든(교체·상대·라인업) 재사용. */
export function PlayerCard({ player, size = 'full', side = 'home', slot, role, stamina, morale, matchStats, star }: PlayerCardProps) {
  const pos = slot ?? player.position
  const axes = playerAxes(player)
  const foot = player.foot ? FOOT_LABEL[player.foot] : null

  return (
    <article className={`pc pc--${size}${star ? ' pc--star' : ''}`} aria-label={`${player.name.ko} 선수 카드`}>
      <header className="pc__head">
        <span className={`pc__avatar pc__avatar--${side}`} aria-hidden="true">{avatarInitials(player)}</span>
        <span className="pc__ident">
          <span className="pc__nameline">
            <span className="pc__num num">{player.number}</span>
            <span className="pc__name">{player.name.ko}</span>
            {star && <span className="pc__star" aria-label="키 플레이어">★</span>}
          </span>
          <span className="pc__posline">
            <span className="pc__pos">{pos}</span>
            {role && <span className="pc__role">{role}</span>}
            {foot && (
              <span className="pc__foot" aria-label={foot.label} title={foot.label}>{foot.short}</span>
            )}
          </span>
        </span>
      </header>

      {axes.length > 0 && <PlayerRadar player={player} showLabels={size === 'full'} />}

      {(stamina != null || morale != null) && (
        <div className="pc__gauges">
          {stamina != null && <Gauge label="체력" value={stamina} kind="stamina" />}
          {morale != null && <Gauge label="사기" value={morale} kind="morale" />}
        </div>
      )}

      {matchStats && <MatchStatLine stats={matchStats} isGk={!!player.gkStats} />}
    </article>
  )
}

/** 이 경기 개인 기록 한 줄.
 *  ★ "유효슛"을 내걸지 않는 이유: 선방당한 슛은 이벤트에 슈터가 남지 않아
 *  유효슛을 정직하게 셀 수 없다(playerStats.ts 주석 참조). 확실한 것만 보여준다. */
function MatchStatLine({ stats, isGk }: { stats: PlayerMatchStats; isGk: boolean }) {
  const cells: { label: string; value: number; warn?: boolean }[] = isGk
    ? [
        { label: '선방', value: stats.saves },
        { label: '파울', value: stats.fouls },
        { label: '경고', value: stats.yellows, warn: stats.yellows > 0 },
      ]
    : [
        { label: '슛', value: stats.shots },
        { label: '골', value: stats.goals },
        { label: '도움', value: stats.assists },
        { label: '파울', value: stats.fouls },
        { label: '경고', value: stats.yellows, warn: stats.yellows > 0 },
      ]
  return (
    <div className="pc__match" aria-label="이 경기 기록">
      <span className="pc__match-title">이 경기</span>
      <span className="pc__match-cells">
        {cells.map(c => (
          <span key={c.label} className={`pc__stat${c.warn ? ' pc__stat--warn' : ''}`}>
            <span className="pc__stat-label">{c.label}</span>
            <span className="pc__stat-val">{c.value}</span>
          </span>
        ))}
        {stats.reds > 0 && (
          <span className="pc__stat pc__stat--red">
            <span className="pc__stat-label">퇴장</span>
            <span className="pc__stat-val">{stats.reds}</span>
          </span>
        )}
      </span>
      {/* 슛 집계의 한계를 라벨 대신 툴팁으로 남긴다 — 카드 안에서 한 줄을 더 쓸 수 없다. */}
      {!isGk && <span className="pc__match-note" title="선방당한 슛은 이벤트에 슈터가 남지 않아 집계에서 빠집니다">ⓘ</span>}
    </div>
  )
}

const VB = 100 // 레이더 viewBox 한 변
const GEO_FULL: RadarGeo = { cx: 50, cy: 52, r: 34 }
const LABEL_GEO: RadarGeo = { cx: 50, cy: 52, r: 46 }

/** 선수 능력치 레이더 SVG(육각/삼각) — 카드 밖(벤치 미니 카드 등)에서도 재사용. */
export function PlayerRadar({ player, showLabels = false, className }: { player: Player; showLabels?: boolean; className?: string }) {
  const axes = playerAxes(player)
  if (axes.length === 0) return null
  return <Radar axes={axes} isGk={!!player.gkStats} showLabels={showLabels} className={className} />
}

function Radar({ axes, isGk, showLabels, className }: { axes: RadarAxis[]; isGk: boolean; showLabels: boolean; className?: string }) {
  const n = axes.length
  const values = axes.map(a => a.value)
  const poly = radarPoints(values, GEO_FULL)
  const grid = axisAnchors(n, GEO_FULL)
  const labelAnchors = axisAnchors(n, LABEL_GEO)
  return (
    <svg
      className={`pc-radar${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${VB} ${VB}`}
      role="img"
      aria-label={`${isGk ? 'GK 3축' : '필드 6축'} 능력치 레이더`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* 그리드: 외곽 다각형 + 축선 */}
      <polygon className="pc-radar__grid" points={ptsAttr(grid)} />
      {grid.map((g, i) => (
        <line key={`ax-${i}`} className="pc-radar__axis" x1={GEO_FULL.cx} y1={GEO_FULL.cy} x2={g.x} y2={g.y} />
      ))}
      {/* 스탯 폴리곤 */}
      <polygon className="pc-radar__poly" points={ptsAttr(poly)} data-n={n} />
      {poly.map((p, i) => (
        <circle key={`pt-${i}`} className="pc-radar__pt" cx={p.x} cy={p.y} r={1.4} />
      ))}
      {showLabels &&
        labelAnchors.map((a, i) => (
          <text
            key={`lb-${i}`}
            className="pc-radar__label"
            x={a.x}
            y={a.y}
            textAnchor={a.x < GEO_FULL.cx - 1 ? 'end' : a.x > GEO_FULL.cx + 1 ? 'start' : 'middle'}
          >
            {axes[i].label}
          </text>
        ))}
    </svg>
  )
}

/** 컨디션 3단 — 40 미만 위험 / 70 미만 주의 / 이상 양호.
 *  색만으로 말하지 않도록 수치를 항상 옆에 붙인다(색맹 대응).
 *  ★ 같은 눈금을 lineup.ts의 staminaTone도 쓴다 — 두 곳에서 임계가 갈리면
 *  같은 선수가 화면마다 다른 색으로 보인다. 값을 바꾸면 양쪽을 함께 바꿔라. */
function conditionTone(value: number): 'low' | 'mid' | 'ok' {
  if (value < 40) return 'low'
  if (value < 70) return 'mid'
  return 'ok'
}

function Gauge({ label, value, kind }: { label: string; value: number; kind: 'stamina' | 'morale' }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const tone = conditionTone(pct)
  return (
    <div className={`pc-gauge pc-gauge--${kind}`}>
      <span className="pc-gauge__label">{label}</span>
      <span className="pc-gauge__track" aria-label={`${label} ${pct}%`}>
        {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
        <span className={`pc-gauge__bar pc-gauge__bar--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="pc-gauge__val num">{pct}</span>
    </div>
  )
}
