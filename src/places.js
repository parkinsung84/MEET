// 네이버 검색 API 키가 없을 때(로컬 개발/테스트) 사용하는 주요 거점 목록
export const PRESET_PLACES = [
  { name: '서울역', lat: 37.5547, lng: 126.9707 },
  { name: '용산역', lat: 37.5298, lng: 126.9648 },
  { name: '강남역', lat: 37.4979, lng: 127.0276 },
  { name: '삼성역', lat: 37.5089, lng: 127.0631 },
  { name: '잠실역', lat: 37.5133, lng: 127.1001 },
  { name: '건대입구역', lat: 37.5404, lng: 127.0692 },
  { name: '왕십리역', lat: 37.5613, lng: 127.0371 },
  { name: '홍대입구역', lat: 37.5572, lng: 126.9245 },
  { name: '신촌역', lat: 37.5552, lng: 126.9368 },
  { name: '여의도역', lat: 37.5216, lng: 126.9243 },
  { name: '종로3가역', lat: 37.5714, lng: 126.9918 },
  { name: '고속터미널역', lat: 37.5049, lng: 127.0049 },
  { name: '사당역', lat: 37.4765, lng: 126.9816 },
  { name: '수원역', lat: 37.2656, lng: 127.0000 },
  { name: '판교역', lat: 37.3948, lng: 127.1112 },
  { name: '김포공항', lat: 37.5586, lng: 126.7945 },
  { name: '인천공항 T1', lat: 37.4492, lng: 126.4508 },
  { name: '인천공항 T2', lat: 37.4690, lng: 126.4337 },
].map((p) => ({ ...p, address: '', category: '주요 거점' }));

export function searchPresetPlaces(query) {
  const q = query.replace(/\s/g, '');
  return PRESET_PLACES.filter((p) => p.name.replace(/\s/g, '').includes(q));
}
