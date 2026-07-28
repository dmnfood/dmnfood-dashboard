const APP_STORAGE_KEY = 'dmnfood_haccp_records_v1';
const SCHEMA_VERSION = 1;

function readStorage() {
    try {
        const raw = localStorage.getItem(APP_STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn('HACCP storage read failed:', error);
        return [];
    }
}

function writeStorage(records) {
    try {
        localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(records));
        return true;
    } catch (error) {
        console.warn('HACCP storage write failed:', error);
        return false;
    }
}

export function listRecords(formType) {
    return readStorage().filter(record => record.formType === formType).sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
    });
}

export function saveRecord(record) {
    const records = readStorage();
    const nextRecord = {
        ...record,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        createdAt: record.createdAt || new Date().toISOString(),
    };

    const existingIndex = records.findIndex(item => item.id === nextRecord.id);
    if (existingIndex >= 0) {
        records[existingIndex] = nextRecord;
    } else {
        nextRecord.id = nextRecord.id || crypto.randomUUID();
        records.unshift(nextRecord);
    }

    return writeStorage(records) ? nextRecord : null;
}

export function getRecordById(id) {
    return readStorage().find(record => record.id === id) || null;
}

export function clearRecords() {
    return writeStorage([]);
}
