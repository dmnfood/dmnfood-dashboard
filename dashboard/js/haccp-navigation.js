const HACCP_CATEGORY_KEY = 'dmnfood:haccp-home-category';
const DEFAULT_HACCP_CATEGORY = 'haccp-all';

function validHaccpCategory(category) {
    return typeof category === 'string' && /^haccp(?:-[a-z]+)?$/.test(category)
        ? (category === 'haccp' ? DEFAULT_HACCP_CATEGORY : category)
        : '';
}

export function rememberHaccpCategory(category) {
    const validCategory = validHaccpCategory(category);
    if (!validCategory) return;
    sessionStorage.setItem(HACCP_CATEGORY_KEY, validCategory);
}

export function getHaccpHomeUrl() {
    const category = validHaccpCategory(sessionStorage.getItem(HACCP_CATEGORY_KEY)) || DEFAULT_HACCP_CATEGORY;
    return `/home?category=${encodeURIComponent(category)}`;
}

export function initializeHaccpHomeLinks(root = document) {
    root.querySelectorAll('[data-haccp-home]').forEach(link => {
        link.setAttribute('href', getHaccpHomeUrl());
    });
}
