/**
 * 출퇴근 거점 (주요 업무지구·역세권). 거점끼리는 모두 노선으로 연결돼 있다 (출발 거점 → 도착 거점).
 * 좌표는 대표 역 기준의 대략적인 위치 (요금 추정·이웃 거점 계산용). 정확한 탑승 위치는 노선 채팅에서 정한다.
 */
export const HUB_GROUPS = ['강남권', '도심', '서북권', '동부권', '서남권', '경기'];

export const HUBS = [
  // 강남권
  { id: 'gangnam', name: '강남역', group: '강남권', lat: 37.4979, lng: 127.0276 },
  { id: 'yeoksam', name: '역삼', group: '강남권', lat: 37.5006, lng: 127.0364 },
  { id: 'eonju', name: '언주', group: '강남권', lat: 37.5074, lng: 127.0340 },
  { id: 'seonjeongneung', name: '선정릉', group: '강남권', lat: 37.5102, lng: 127.0438 },
  { id: 'seolleung', name: '선릉', group: '강남권', lat: 37.5045, lng: 127.0490 },
  { id: 'samseong', name: '삼성', group: '강남권', lat: 37.5089, lng: 127.0631 },
  { id: 'coex', name: '코엑스', group: '강남권', lat: 37.5125, lng: 127.0588 },
  { id: 'daechi', name: '대치', group: '강남권', lat: 37.4945, lng: 127.0633 },
  { id: 'dogok', name: '도곡', group: '강남권', lat: 37.4909, lng: 127.0555 },
  { id: 'yangjae', name: '양재', group: '강남권', lat: 37.4844, lng: 127.0343 },
  { id: 'seocho', name: '서초', group: '강남권', lat: 37.4918, lng: 127.0077 },
  { id: 'banpo', name: '반포', group: '강남권', lat: 37.5082, lng: 127.0115 },
  { id: 'jamwon', name: '잠원', group: '강남권', lat: 37.5129, lng: 127.0112 },
  { id: 'express-terminal', name: '고속터미널', group: '강남권', lat: 37.5049, lng: 127.0049 },
  { id: 'apgujeong', name: '압구정', group: '강남권', lat: 37.5271, lng: 127.0284 },
  { id: 'cheongdam', name: '청담', group: '강남권', lat: 37.5192, lng: 127.0536 },
  { id: 'sadang', name: '사당', group: '강남권', lat: 37.4766, lng: 126.9816 },
  // 도심
  { id: 'seoul-station', name: '서울역', group: '도심', lat: 37.5547, lng: 126.9707 },
  { id: 'gwanghwamun', name: '광화문', group: '도심', lat: 37.5716, lng: 126.9768 },
  { id: 'jongno', name: '종로', group: '도심', lat: 37.5702, lng: 126.9831 },
  { id: 'euljiro', name: '을지로', group: '도심', lat: 37.5660, lng: 126.9823 },
  { id: 'myeongdong', name: '명동', group: '도심', lat: 37.5609, lng: 126.9863 },
  { id: 'yongsan', name: '용산', group: '도심', lat: 37.5298, lng: 126.9648 },
  { id: 'ichon', name: '이촌', group: '도심', lat: 37.5222, lng: 126.9742 },
  { id: 'hannam', name: '한남', group: '도심', lat: 37.5294, lng: 127.0090 },
  { id: 'wangsimni', name: '왕십리', group: '도심', lat: 37.5612, lng: 127.0371 },
  { id: 'cheongnyangni', name: '청량리', group: '도심', lat: 37.5802, lng: 127.0470 },
  // 서북권
  { id: 'hongdae', name: '홍대', group: '서북권', lat: 37.5572, lng: 126.9245 },
  { id: 'sinchon', name: '신촌', group: '서북권', lat: 37.5552, lng: 126.9369 },
  { id: 'hapjeong', name: '합정', group: '서북권', lat: 37.5496, lng: 126.9139 },
  { id: 'mapo', name: '마포·공덕', group: '서북권', lat: 37.5443, lng: 126.9516 },
  { id: 'sangam', name: '상암DMC', group: '서북권', lat: 37.5770, lng: 126.8995 },
  { id: 'yeonsinnae', name: '연신내', group: '서북권', lat: 37.6190, lng: 126.9210 },
  // 동부권
  { id: 'jamsil', name: '잠실', group: '동부권', lat: 37.5133, lng: 127.1001 },
  { id: 'songpa', name: '송파', group: '동부권', lat: 37.4996, lng: 127.1121 },
  { id: 'olympic-park', name: '올림픽공원', group: '동부권', lat: 37.5163, lng: 127.1310 },
  { id: 'munjeong', name: '문정', group: '동부권', lat: 37.4859, lng: 127.1225 },
  { id: 'suseo', name: '수서', group: '동부권', lat: 37.4873, lng: 127.1017 },
  { id: 'cheonho', name: '천호', group: '동부권', lat: 37.5386, lng: 127.1236 },
  { id: 'konkuk', name: '건대', group: '동부권', lat: 37.5404, lng: 127.0703 },
  { id: 'seongsu', name: '성수', group: '동부권', lat: 37.5446, lng: 127.0557 },
  { id: 'seoul-forest', name: '서울숲', group: '동부권', lat: 37.5436, lng: 127.0446 },
  { id: 'nowon', name: '노원', group: '동부권', lat: 37.6560, lng: 127.0612 },
  // 서남권
  { id: 'yeouido', name: '여의도', group: '서남권', lat: 37.5216, lng: 126.9243 },
  { id: 'heukseok', name: '흑석', group: '서남권', lat: 37.5088, lng: 126.9636 },
  { id: 'magok', name: '마곡', group: '서남권', lat: 37.5668, lng: 126.8272 },
  { id: 'mokdong', name: '목동', group: '서남권', lat: 37.5261, lng: 126.8645 },
  { id: 'gasan', name: '가산디지털단지', group: '서남권', lat: 37.4816, lng: 126.8826 },
  { id: 'guro-digital', name: '구로디지털단지', group: '서남권', lat: 37.4852, lng: 126.9015 },
  { id: 'sillim', name: '신림', group: '서남권', lat: 37.4842, lng: 126.9297 },
  // 경기
  { id: 'pangyo', name: '판교', group: '경기', lat: 37.3948, lng: 127.1112 },
  { id: 'jeongja', name: '분당 정자', group: '경기', lat: 37.3670, lng: 127.1085 },
];

const byId = new Map(HUBS.map((hub) => [hub.id, hub]));
export const getHub = (id) => byId.get(String(id)) ?? null;

/**
 * 추천 노선 (첫 화면): 사람들이 많이 사는 곳 → 주요 업무지구 출근길 위주.
 * 반대 방향(퇴근길)은 노선 화면에서 바로 갈 수 있다.
 */
export const FEATURED_ROUTES = [
  ['jamsil', 'gangnam'], ['jamsil', 'samseong'], ['jamsil', 'yeouido'], ['jamsil', 'gwanghwamun'],
  ['songpa', 'yeoksam'], ['olympic-park', 'seolleung'], ['suseo', 'gangnam'], ['munjeong', 'samseong'],
  ['jeongja', 'gangnam'], ['jeongja', 'yeoksam'], ['pangyo', 'gangnam'], ['gangnam', 'pangyo'],
  ['banpo', 'yeouido'], ['jamwon', 'gwanghwamun'], ['seocho', 'yeouido'], ['express-terminal', 'jongno'],
  ['mapo', 'gangnam'], ['hongdae', 'yeouido'], ['hongdae', 'gangnam'], ['sinchon', 'gwanghwamun'],
  ['mokdong', 'yeouido'], ['magok', 'yeouido'], ['magok', 'gangnam'], ['sangam', 'gwanghwamun'],
  ['konkuk', 'gangnam'], ['seongsu', 'yeoksam'], ['wangsimni', 'euljiro'], ['cheonho', 'samseong'],
  ['yongsan', 'gangnam'], ['ichon', 'yeouido'], ['hannam', 'gwanghwamun'], ['apgujeong', 'yeouido'],
  ['nowon', 'jongno'], ['sillim', 'gangnam'], ['sadang', 'yeouido'], ['guro-digital', 'yeouido'],
  ['gasan', 'magok'], ['heukseok', 'gangnam'], ['seoul-station', 'pangyo'], ['yeonsinnae', 'gwanghwamun'],
];
