(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanRouteAlternatives = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function itinerarySignature(itinerary) {
    return (itinerary?.legs || []).map((leg) => [leg.mode, leg.routeName, leg.fromId || leg.fromName, leg.toId || leg.toName].join(':')).join('|');
  }

  function valueOrInfinity(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : Infinity;
  }

  function alternativeOptions(itinerary) {
    const source = Array.isArray(itinerary?.alternatives) ? itinerary.alternatives : [itinerary];
    const distinct = [];
    const seen = new Set();
    source.filter(Boolean).forEach((item) => {
      const signature = itinerarySignature(item);
      if (!signature || seen.has(signature)) return;
      seen.add(signature);
      distinct.push(item);
    });

    const fastest = distinct
      .map((item, index) => ({ item, index }))
      .sort((left, right) => valueOrInfinity(left.item.duration) - valueOrInfinity(right.item.duration) || left.index - right.index)
      .map(({ item }) => item);
    const selected = fastest.slice(0, 2);
    const walking = distinct
      .filter((item) => !selected.includes(item))
      .map((item, index) => ({ item, index }))
      .sort((left, right) => valueOrInfinity(left.item.walkDuration) - valueOrInfinity(right.item.walkDuration)
        || valueOrInfinity(left.item.duration) - valueOrInfinity(right.item.duration)
        || left.index - right.index)
      .map(({ item }) => item)[0];
    if (walking) selected.push(walking);

    const labels = [
      { key: 'fastest', label: 'Fastest' },
      { key: 'transfers', label: 'Second fastest' },
      { key: 'walking', label: 'Less walking' },
    ];
    return selected.map((item, index) => ({ ...labels[index], itinerary: item }));
  }

  return { itinerarySignature, alternativeOptions };
}));
