/** 시간대별로 좁힌 뒤 빈자리가 있는 크루부터 출발 시각순으로 표시한다. */
export function selectCrews(commutes, period = 'all') {
  return commutes.filter((c) => {
    const hour = Number(c.departTime.split(':')[0]);
    return period === 'morning' ? hour < 12
      : period === 'afternoon' ? hour >= 12 && hour < 17
      : period === 'evening' ? hour >= 17 : true;
  }).sort((a, b) => Number(b.seatsLeft > 0) - Number(a.seatsLeft > 0)
    || a.departTime.localeCompare(b.departTime));
}
