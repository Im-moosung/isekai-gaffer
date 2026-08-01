#!/usr/bin/env node
// tools/team-balance/recalibrate.mjs
//
// 팀 전력을 FIFA 랭킹 사다리에 맞추는 스쿼드 재보정. **엔진에는 손대지 않는다** —
// 바꾸는 것은 선수 능력치와 statBaseline뿐이고, 근거는 각 항목의 `why`에 적는다.
// 각 팀의 profile.styleNotes가 선언한 정체성을 지키는 축만 건드린다.
//
// 파일 서식 보존: 선수 한 명이 정확히 한 줄이므로 해당 줄 안에서만 치환한다.
// 결정론: 입력 JSON과 이 표만으로 출력이 정해진다. 난수·시각 없음.
//
// 사용: node tools/team-balance/recalibrate.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry')

/** @type {Record<string, {why: string, baseline?: Record<string, number>, players?: Record<string, Record<string, number>>}>} */
const PATCH = {
  // ── 1위인데 가장 쉬운 강팀이었다 ──────────────────────────────
  // 실측(재보정 전, n=2000): 한국 승률 arg 29% > eng 26% > esp 18% > fra 15%.
  // 원인은 능력치가 아니라 **편성**이었다. 4-2-2-2가 엔진 6종에 없어 4-4-2로 매핑되는데,
  // 4-4-2의 중원 슬롯은 2개뿐이라 zoneStrength.countFactor가 (2/3)^0.2 = 0.923을 곱한다.
  // 그래서 데 파울·엔소를 세우고도 미드필드 존이 69.8로 12팀 중 아래에서 세 번째였다.
  // 스칼로니의 아르헨티나는 2022 결승·2024 코파 결승 모두 4-3-3(데 파울·엔소·맥알리스터)로
  // 섰다. 선호 포메이션 정본을 4-3-3으로 바꾸면 중원이 3명이 되어 계수가 1.0이 된다.
  arg: {
    why: '4-3-3 정본화 + 남미예선 실측 슈팅으로 베이스라인 상향',
    formations: ['4-3-3', '4-2-2-2', '4-1-4-1'],
    baseline: {
      // 2026 남미예선 우승(2위와 승점 10차) 구간의 경기당 슈팅에 맞춘다. 12.7은 카타르
      // 월드컵 7경기 표본이라 녹아웃의 저점유 경기가 눌러 놓은 값이었다.
      shotsPerGame: 15.4, shotsOnTargetPerGame: 6.4, cornersPerGame: 5.8,
    },
    players: {
      // 토트넘 주장·프리미어리그 주전 CB. 수비/피지컬을 1위 팀 중앙수비 수준으로.
      'Cristian Romero': { defending: 86, physical: 86 },
      // 2023·2024 야신 트로피 2회 수상. 12팀 통틀어 최고 선방 자원인데
      // 부누(86)·마이냥과 같은 값이었다.
      'Emiliano Martínez': { saving: 88 },
      // 로메로와 함께 2022 우승 센터백 조합. 짝보다 낮게 매겨져 있었다.
      'Lisandro Martínez': { defending: 86, physical: 82 },
      // 첼시 주전이자 클럽월드컵 우승 주역. 중원 존 가중(passing·dribbling·defending) 중
      // 수비 기여가 과소평가돼 있었다.
      'Enzo Fernández': { passing: 86, defending: 70 },
      'Rodrigo De Paul': { defending: 74 },
      // 리옹 주장·리그 1 주전 풀백.
      'Nicolás Tagliafico': { defending: 76, physical: 73 },
      'Nahuel Molina': { defending: 76 },
      'Alexis Mac Allister': { defending: 70, passing: 84 },
      // 인터 밀란 통산 득점 5위권. 결정력을 1위 팀 주전 스트라이커 수준으로.
      'Lautaro Martínez': { shooting: 88 },
      // 아틀레티코 마드리드 주전, 2024-25 팀 내 최다 득점.
      'Julián Álvarez': { shooting: 86 },
      'Nicolás González': { shooting: 76, pace: 84 },
    },
  },

  // ── 2위인데 3위보다 쉬웠다 ────────────────────────────────────
  // 유로 2024 우승·네이션스리그 우승. 정체성('극단적 점유·포지셔널')은 점유·패스 축이므로
  // 슈팅 볼륨은 건드리지 않고 스쿼드 축만 올린다.

  // ── 3위인데 가장 어려웠다 ─────────────────────────────────────
  // 정체성은 '점유율이 낮아도 슈팅·xG를 압도'다. 슈팅 우위 자체는 지켜야 하므로
  // 볼륨을 스페인 아래로만 내린다(17.0 → 14.4: 아르헨티나·스페인 다음 3위).
  // 근거: 17.0은 카타르 월드컵 결승 진출 7경기 값이고, 유로 2024 6경기에서는
  // 경기당 슈팅이 13대로 떨어졌다. 두 대회를 함께 반영한 값이 14.4다.
  fra: {
    why: '슈팅 볼륨을 두 대회 평균으로(스페인 아래·2위 유지) + 좌측 공격 자원 실측 조정',
    baseline: { shotsPerGame: 14.4, shotsOnTargetPerGame: 5.9, cornersPerGame: 5.6 },
    players: {
      // PSG 로테이션 윙어. 드리블 84·페이스 88은 뎀벨레(90/88)와 사실상 동급이라
      // 팀 내 서열과 맞지 않았다. 공격 존 가중이 (shooting·dribbling·pace)/3이라
      // 이 셋이 그대로 존 전력이 된다.
      'Bradley Barcola': { dribbling: 80, pace: 86, shooting: 72 },
      // 사우디 프로리그(알 힐랄) 소속. 리그 수준을 반영해 수비·피지컬만 조정한다.
      'Théo Hernandez': { defending: 70, physical: 72 },
      // 페이스 82는 12팀 중앙수비 최고값이었다(음바페 92·뎀벨레 88과 같은 대역).
      'Dayot Upamecano': { pace: 79 },
    },
  },

  // ── 7위가 60위와 같은 난이도였다 (가장 큰 이상) ────────────────
  // 정체성은 '적은 슈팅으로 득점하는 효율 극대화'다. 그래서 **볼륨이 아니라 질**을 올린다.
  //  · shotsPerGame은 8.0 → 12.6. 한국(13.0)·멕시코(13.2)·에콰도르(13.3)보다 여전히 적고,
  //    유효슈팅 비율은 5.5/12.6 = 43.7%로 12팀 중 최고가 된다 — '적은 슈팅·높은 효율'을
  //    수치로 정확히 표현한 값이다. 8.0은 카타르 월드컵 녹아웃 4경기(벨기에·스페인·포르투갈·
  //    프랑스전 저블록)가 눌러 놓은 표본이었다.
  //  · 대신 전방 3인의 shooting을 올려 '슛 하나의 값'을 키운다 — resolveChance의
  //    chanceQuality가 슈터 shooting에 정비례하므로 이것이 효율 축이다.
  //  · 하키미가 RB로 복귀한 것은 배열 순서 수정(reorder.mjs)에서 이미 반영됐다.
  mar: {
    why: '볼륨 대신 결정력·후방 강도로 7위 수준 복원(저슈팅 효율 정체성 유지)',
    baseline: { shotsPerGame: 12.6, shotsOnTargetPerGame: 5.5, possession: 54.0, passAccuracy: 84.0, cornersPerGame: 5.4 },
    players: {
      // 크리스털 팰리스 주전 CB, 2025 FA컵 우승. 프리미어리그 주전 수준으로.
      'Chadi Riad': { defending: 78, physical: 80 },
      'Issa Diop': { defending: 78 },
      // 아부다비·올림피아코스 득점왕급 자원. 효율 정체성의 핵심이라 결정력을 올린다.
      'Soufiane Rahimi': { shooting: 78, dribbling: 78 },
      'Ayoub El Kaabi': { shooting: 80 },
      // 선덜랜드(프리미어리그) 주전 윙어.
      'Chemsdine Talbi': { shooting: 72, dribbling: 82 },
      // 앙제(리그 1) 주전. 좌측이 전방 3인 중 유일하게 60대였다.
      'Amine Sbaï': { shooting: 70, dribbling: 78, pace: 82 },
      // 베티스 주전 DM. 중원 회수의 축.
      'Sofyan Amrabat': { defending: 80 },
      // 로마 주전 중원.
      'Neil El Aynaoui': { passing: 78, defending: 70 },
      // 2021-22 라리가 사모라(최소 실점) 수상, 2022 월드컵 4강의 중심.
      // 정체성 문장이 '부누의 골키핑이 승부처를 지배했다'로 못 박은 축이다.
      'Yassine Bounou': { saving: 86 },
      'Azzedine Ounahi': { passing: 78 },
      // PSG 주전 라이트백. 수비 기여를 소속 수준으로.
      'Achraf Hakimi': { defending: 78 },
      // PSV 주전 레프트백. 백4에서 유일하게 60대였다.
      'Anass Salah-Eddine': { defending: 72, physical: 68 },
    },
  },

  // ── 14위가 23·30·31위와 뭉쳐 있었다 ──────────────────────────
  // 정체성은 '알바레스 단일 피벗 + 견고한 수비 + 빠른 전환'. 수비 축과 결정력만 올린다.
  mex: {
    why: '개최국·14위 수준으로 중앙수비와 전방 결정력 상향(단일 피벗 정체성 유지)',
    baseline: { shotsPerGame: 13.2, shotsOnTargetPerGame: 5.0 },
    players: {
      'César Montes': { defending: 78, pace: 72 },
      'Johan Vásquez': { defending: 78, pace: 74 },
      'Edson Álvarez': { defending: 84 },
      'Raúl Jiménez': { shooting: 82 },
      'Julián Quiñones': { shooting: 76 },
      'Alexis Vega': { shooting: 74 },
      'Luis Romo': { passing: 76 },
    },
  },

  // ── 23위가 30·31위와 구분되지 않았다 ─────────────────────────
  // 정체성은 '더블 피벗 기반의 견고한 중원 + 인카피에·파초·M.카이세도의 수비 척추,
  // 그러나 마무리 결정력이 치명적 약점'. 그런데 4-2-2-2 → 4-4-2 매핑 탓에
  // **카이세도가 XI에서 빠져** 미드필드 존이 61.8로 12팀 최하위였다 —
  // 선언된 정체성과 정반대다. 선호 포메이션을 4-2-3-1로 바꿔 더블 피벗을 복원한다.
  // 결정력 약점은 손대지 않는다(슈팅 축 그대로).
  ecu: {
    why: '더블 피벗 복원(4-2-3-1) — 선언된 정체성과 XI가 어긋나 있었다',
    formations: ['4-2-3-1', '4-2-2-2', '4-4-2'],
  },

  // ── 31위가 7·14위보다 어려웠다 ───────────────────────────────
  // 홀란(shooting 92)은 실측 그대로 둔다 — '홀란 의존도가 구조적으로 크다'가 정체성이다.
  // 대신 홀란 주변, 즉 노르웨이가 31위인 이유(측면·후방의 깊이)를 랭킹 수준으로 내린다.
  nor: {
    why: '홀란은 불변, 주변 자원을 31위 수준으로 — 홀란 의존 정체성을 오히려 강화한다',
    players: {
      'Ørjan Nyland': { saving: 76 },
      // 라이프치히 2005년생. 드리블 82·페이스 86은 12팀 측면 자원 최상위권 값이었다.
      'Antonio Nusa': { dribbling: 78, pace: 82 },
      // 2024-25 장기 결장 후 복귀 시즌.
      'Oscar Bobb': { dribbling: 78, pace: 78, shooting: 66 },
      'Kristoffer Ajer': { pace: 76, physical: 78, defending: 76 },
      'Leo Østigård': { physical: 78, defending: 76 },
      'Sander Berge': { physical: 76, passing: 74 },
      'Julian Ryerson': { defending: 74, pace: 78 },
      'David Møller Wolfe': { defending: 66 },
    },
  },

  // ── 30위가 31위보다 쉬웠다 ───────────────────────────────────
  // 정체성은 데이비스의 좌측 폭발력 + 전방 침투. 중원이 64.5로 12팀 최하위권이라
  // 그 좌측을 받쳐 줄 축이 없었다. 중원 회수·전개와 최전방 결정력만 올린다.
  can: {
    why: '중원 축(코네·에우스타키우)과 최전방을 30위 수준으로 — 좌측 정체성은 불변',
    players: {
      'Ismaël Koné': { passing: 76, defending: 74 },
      'Stephen Eustáquio': { passing: 78, defending: 72 },
      'Derek Cornelius': { defending: 76 },
      'Moïse Bombito': { defending: 76, pace: 78 },
      'Alistair Johnston': { defending: 76 },
      // 2024 MLS 올해의 골키퍼.
      'Dayne St. Clair': { saving: 80 },
      'Jonathan Osorio': { passing: 76 },
      // 유벤투스 이적 시즌. 릴에서 5시즌 연속 두 자릿수 득점.
      'Jonathan David': { shooting: 84 },
    },
  },

  // ── 40위가 60위와 같은 난이도였다 ────────────────────────────
  // 정체성은 '실리적 수비 조직 + 세트피스·공중볼, 중앙 창의성 부족'.
  // 창의성(passing·dribbling)은 그대로 두고 **수비 조직과 공중볼**만 올린다.
  // 3-4-2-1(→3-5-2) 백3는 countFactor (3/4)^0.2 = 0.944를 물기 때문에 개별 값이
  // 같아도 존 전력이 낮게 나온다 — 이 구조적 손해를 개인 능력으로 메운다.
  cze: {
    why: '백3 편성 손해를 수비 개인 능력으로 상쇄 + 유효슈팅 비율 정상화',
    baseline: {
      // 슈팅 9.0에 유효슈팅 2.5는 27.8%로 12팀 최저였다. 장신 표적에 의한 세트피스
      // 마무리가 정체성인 팀의 값으로 보기 어렵다. 33%대로 올린다.
      shotsPerGame: 9.6, shotsOnTargetPerGame: 3.2,
    },
    players: {
      'Ladislav Krejčí': { defending: 80, physical: 80 },
      'Robin Hranáč': { defending: 76, physical: 78 },
      'David Zima': { defending: 74, physical: 78 },
      'Tomáš Souček': { physical: 84 },
      'Patrik Schick': { shooting: 84 },
    },
  },
}

for (const [id, patch] of Object.entries(PATCH)) {
  const path = `data/teams/${id}.json`
  let raw = readFileSync(path, 'utf8')
  const before = raw
  if (patch.formations) {
    raw = raw.replace(/"preferredFormations": \[[^\]]*\]/, `"preferredFormations": [${patch.formations.map(f => `"${f}"`).join(', ')}]`)
  }
  // statBaseline 블록 안에서만 치환한다. profile.style에도 "possession"이 있어서
  // 파일 전체 치환을 하면 스타일 슬라이더를 덮어쓴다(정체성 파괴).
  if (patch.baseline) {
    const start = raw.indexOf('"statBaseline"')
    if (start < 0) throw new Error(`${id}: statBaseline 없음`)
    const end = raw.indexOf('"squad"', start)
    let block = raw.slice(start, end)
    for (const [k, v] of Object.entries(patch.baseline)) {
      const re = new RegExp(`("${k}": )(-?[0-9.]+)`)
      if (!re.test(block)) throw new Error(`${id}: statBaseline.${k} 없음`)
      block = block.replace(re, `$1${v}`)
    }
    raw = raw.slice(0, start) + block + raw.slice(end)
  }
  for (const [name, stats] of Object.entries(patch.players ?? {})) {
    const lines = raw.split('\n')
    const li = lines.findIndex(l => l.includes(`"en": "${name}"`))
    if (li < 0) throw new Error(`${id}: 선수 ${name} 없음`)
    let line = lines[li]
    for (const [k, v] of Object.entries(stats)) {
      const re = new RegExp(`("${k}": )(-?[0-9.]+)`)
      if (!re.test(line)) throw new Error(`${id}/${name}: ${k} 없음`)
      line = line.replace(re, `$1${v}`)
    }
    lines[li] = line
    raw = lines.join('\n')
  }
  JSON.parse(raw)
  if (!DRY) writeFileSync(path, raw)
  console.log(`${id}: ${patch.why}${before === raw ? '  (변화 없음)' : ''}`)
}
