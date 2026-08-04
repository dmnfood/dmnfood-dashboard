import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    where,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';
import { normalizeHeatingValues } from '/dashboard/js/haccp-form-common.js';

const RECORDS_COLLECTION = 'haccpHeatingRecords';
const SETTINGS_DOCUMENT = 'haccpSettings/heating';
const LOCAL_RECORDS_KEY = 'dmnfood_haccp_records_v1';
const MIGRATION_KEY = 'dmnfood_haccp_heating_firestore_migration_v1';

export const DEFAULT_HEATING_SETTINGS = Object.freeze({
    schemaVersion: 1,
    inspectorName: '김석기',
    productName: '참기름',
    productSurfaceTempMin: 170,
    productSurfaceTempMax: 200,
    heatingMinutesTarget: 22,
    heatingMinutesTolerance: 3,
    roasterSetTemperatures: { '1': 185, '2': 185, '3': 185, '4': 185 },
});

export function calculateHeatingJudgment(productSurfaceTemperature, settings = DEFAULT_HEATING_SETTINGS) {
    const temperature = asNumber(productSurfaceTemperature);
    if (temperature === null) return '';
    return temperature >= settings.productSurfaceTempMin && temperature <= settings.productSurfaceTempMax ? 'PASS' : 'FAIL';
}

function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function timestampToIso(timestamp) {
    return timestamp?.toDate ? timestamp.toDate().toISOString() : '';
}

export async function loadHeatingSettings() {
    const snapshot = await getDoc(doc(db, SETTINGS_DOCUMENT));
    if (!snapshot.exists()) return { ...DEFAULT_HEATING_SETTINGS, roasterSetTemperatures: { ...DEFAULT_HEATING_SETTINGS.roasterSetTemperatures } };
    const saved = snapshot.data();
    return {
        ...DEFAULT_HEATING_SETTINGS,
        ...saved,
        roasterSetTemperatures: { ...DEFAULT_HEATING_SETTINGS.roasterSetTemperatures, ...(saved.roasterSetTemperatures || {}) },
    };
}

// Reserved for the future settings popup; loading never overwrites a missing settings document.
export async function saveHeatingSettings(settings, user) {
    await setDoc(doc(db, SETTINGS_DOCUMENT), {
        ...DEFAULT_HEATING_SETTINGS,
        ...settings,
        schemaVersion: 1,
        updatedByUid: user?.uid || '',
        updatedAt: serverTimestamp(),
    }, { merge: true });
}

export function toCompatibleHeatingRecord(snapshot) {
    const data = snapshot.data();
    return {
        id: snapshot.id,
        schemaVersion: data.schemaVersion || 1,
        formType: 'heating',
        recordDate: data.recordDate || '',
        workerId: data.createdByUid || '',
        workerName: data.inspectorName || '',
        productName: data.productName || '',
        judgement: data.judgment || '',
        deviationDetail: data.deviationDetail || '',
        correctiveAction: data.correctiveActionResult || '',
        actionBy: data.actionBy || '',
        verifiedBy: data.verifiedBy || '',
        notes: data.notes || '',
        measurements: {
            roasterNo: String(data.roasterNo ?? ''),
            setTemperature: data.setTemperature == null ? '' : String(data.setTemperature),
            measuredTime: data.measuredTime || '',
            heatingMinutes: data.heatingMinutes == null ? '' : String(data.heatingMinutes),
            heatingSeconds: data.heatingSeconds == null ? '' : String(data.heatingSeconds),
            heatingTotalSeconds: data.heatingTotalSeconds == null ? '' : String(data.heatingTotalSeconds),
            productTemperature: data.productSurfaceTemperature == null ? '' : String(data.productSurfaceTemperature),
        },
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
    };
}

export function subscribeToHeatingRecords(onRecords, onError) {
    const recordsQuery = query(collection(db, RECORDS_COLLECTION), orderBy('createdAt', 'desc'), limit(100));
    return onSnapshot(recordsQuery, (snapshot) => {
        onRecords(snapshot.docs.map(toCompatibleHeatingRecord));
    }, onError);
}

export function subscribeHeatingRecordsByDate(recordDate, onRecords, onError) {
    const recordsQuery = query(collection(db, RECORDS_COLLECTION), where('recordDate', '==', recordDate));
    return onSnapshot(recordsQuery, snapshot => {
        onRecords(snapshot.docs.map(toCompatibleHeatingRecord));
    }, onError);
}

export async function saveHeatingRecord(values, user, existingId = '', settings = DEFAULT_HEATING_SETTINGS) {
    const measurements = normalizeHeatingValues(values.measurements);
    const temperature = asNumber(measurements.productTemperature);
    const judgment = calculateHeatingJudgment(temperature, settings);
    const payload = {
        schemaVersion: 1,
        recordDate: values.recordDate,
        inspectorName: values.workerName,
        productName: values.productName,
        roasterNo: asNumber(measurements.roasterNo),
        setTemperature: asNumber(measurements.setTemperature),
        measuredTime: measurements.measuredTime,
        heatingMinutes: asNumber(measurements.heatingMinutes),
        heatingSeconds: asNumber(measurements.heatingSeconds),
        heatingTotalSeconds: asNumber(measurements.heatingTotalSeconds),
        productSurfaceTemperature: temperature,
        judgment,
        deviationDetail: judgment === 'FAIL' ? values.deviationDetail : '',
        correctiveActionResult: judgment === 'FAIL' ? values.correctiveAction : '',
        actionBy: judgment === 'FAIL' ? values.actionBy : '',
        verifiedBy: judgment === 'FAIL' ? values.verifiedBy : '',
        notes: values.notes,
        createdByUid: user?.uid || '',
        createdByEmail: user?.email || '',
        updatedAt: serverTimestamp(),
    };

    if (existingId) {
        await setDoc(doc(db, RECORDS_COLLECTION, existingId), payload, { merge: true });
        return existingId;
    }
    const created = await addDoc(collection(db, RECORDS_COLLECTION), { ...payload, createdAt: serverTimestamp() });
    return created.id;
}

export async function deleteHeatingRecord(id) {
    await deleteDoc(doc(db, RECORDS_COLLECTION, id));
}

// Deliberately not called automatically: local records remain untouched until an authorized migration action is added.
export async function migrateLocalHeatingRecordsOnce(user) {
    const migration = JSON.parse(localStorage.getItem(MIGRATION_KEY) || '{"migratedIds":[]}');
    const migratedIds = new Set(migration.migratedIds || []);
    const records = JSON.parse(localStorage.getItem(LOCAL_RECORDS_KEY) || '[]').filter(record => record.formType === 'heating');
    for (const record of records) {
        if (migratedIds.has(record.id)) continue;
        await saveHeatingRecord({
            recordDate: record.recordDate,
            workerName: record.workerName,
            productName: record.productName,
            judgement: record.judgement,
            deviationDetail: record.deviationDetail || '',
            correctiveAction: record.correctiveAction || '',
            actionBy: record.actionBy || '',
            verifiedBy: record.verifiedBy || '',
            notes: record.notes || '',
            measurements: record.measurements || {},
        }, user, '', DEFAULT_HEATING_SETTINGS);
        migratedIds.add(record.id);
        localStorage.setItem(MIGRATION_KEY, JSON.stringify({ migratedIds: [...migratedIds], migratedAt: new Date().toISOString() }));
    }
    return migratedIds.size;
}
