export const PRODUCTION_OPTIONS = Object.freeze({
  sesame_oil: Object.freeze({
    label: '참기름',
    sizeUnit: 'ml',
    categories: Object.freeze({
      korea: Object.freeze({ label: '국산', sizes: Object.freeze([150, 180, 250, 300, 500, 1000, 1800]) }),
      china: Object.freeze({ label: '중국산', sizes: Object.freeze([180, 250, 350, 1000, 1800]), sizeColumns: 5 }),
      imported: Object.freeze({
        label: '수입산', sizes: Object.freeze([180, 250, 350, 1000, 1800]), sizeColumns: 3,
        bottleTypes: Object.freeze({ square: '사각병', round: '원형병' }), legacySizes: Object.freeze([270]),
      }),
      imported_sesame_powder: Object.freeze({ label: '수입깨분', sizes: Object.freeze([180, 250, 1000, 1800]), sizeColumns: 4, legacySizes: Object.freeze([270]) }),
    }),
  }),
  roasted_sesame: Object.freeze({
    label: '볶음통깨',
    sizeUnit: 'g',
    categories: Object.freeze({
      korea: Object.freeze({ label: '국산', sizes: Object.freeze([65, 80, 130, 1000]) }),
      china: Object.freeze({ label: '중국산', sizes: Object.freeze([120, 1000]) }),
      imported: Object.freeze({ label: '수입산', sizes: Object.freeze([120, 140, 1000]) }),
    }),
  }),
});

export function productionSizeLabel(item) {
  const { sizeValue: value, sizeUnit: unit } = item;
  if (value === '' || value == null) return '';
  const label = Number(value) === 1000 ? (unit === 'ml' ? '1L' : '1kg')
    : Number(value) === 1800 && unit === 'ml' ? '1.8L' : `${value}${unit}`;
  const bottle = PRODUCTION_OPTIONS[item.productType]?.categories[item.sourceCategory]?.bottleTypes?.[item.bottleType];
  return bottle ? `${label}(${bottle})` : label;
}

export function productionSizeOptions(productType, sourceCategory) {
  const product = PRODUCTION_OPTIONS[productType];
  const category = product?.categories[sourceCategory];
  if (!category) return [];
  return category.sizes.flatMap(sizeValue => {
    const base = { productType, sourceCategory, sizeValue, sizeUnit: product.sizeUnit };
    return category.bottleTypes && sizeValue === 250
      ? Object.keys(category.bottleTypes).map(bottleType => ({ ...base, bottleType }))
      : [base];
  });
}

// Leave keys for existing records unchanged; only new bottle variants get a suffix.
export const productionItemKey = item => `${item.productType}:${item.sourceCategory}:${item.sizeUnit}:${Number(item.sizeValue)}${item.bottleType ? `:${item.bottleType}` : ''}`;

export function isAllowedProductionItem(item) {
  const product = PRODUCTION_OPTIONS[item.productType];
  const category = product?.categories[item.sourceCategory];
  const value = Number(item.sizeValue);
  const bottleType = item.bottleType || '';
  const validBottle = category?.bottleTypes && value === 250
    ? Object.hasOwn(category.bottleTypes, bottleType) : !bottleType;
  return Boolean(product && category && validBottle
    && item.sizeUnit === product.sizeUnit
    && (category.sizes.includes(value) || category.legacySizes?.includes(value))
    && Number.isFinite(Number(item.quantity))
    && Number(item.quantity) >= 0);
}

export function normalizeProductionItems(items) {
  return items.map(item => ({
    productType: item.productType,
    sourceCategory: item.sourceCategory,
    sizeValue: Number(item.sizeValue),
    sizeUnit: item.sizeUnit,
    ...(item.bottleType ? { bottleType: item.bottleType } : {}),
    quantity: Number(item.quantity),
  }));
}

export function upsertProductionItem(currentItems, nextItem, editingKey = '') {
  const normalized = normalizeProductionItems([nextItem])[0];
  const nextKey = productionItemKey(normalized);
  const items = editingKey
    ? currentItems.filter(item => productionItemKey(item) !== editingKey).map(item => ({ ...item }))
    : currentItems.map(item => ({ ...item }));
  const duplicateIndex = items.findIndex(item => productionItemKey(item) === nextKey);
  if (duplicateIndex >= 0) items[duplicateIndex] = normalized;
  else items.push(normalized);
  return { items, replacedExisting: duplicateIndex >= 0 };
}
