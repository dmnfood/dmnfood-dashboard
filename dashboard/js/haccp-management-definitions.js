export const CCP_GROUPS = Object.freeze([
  { key: 'heating', label: '가열공정', questions: [
    { key:'heating_periodic_monitoring', text:'종사자가 주기적으로 가열 온도, 가열 시간 및 가열 후 품온을 확인하고, 그 내용을 기록하고 있습니까?' },
    { key:'heating_thermometer_calibration', text:'온도계는 연 1회 이상 검·교정이 이루어지고 있습니까?' },
    { key:'heating_method_knowledge', text:'종사자가 가열온도 및 가열 후 품온을 확인하는 방법을 정확히 알고 있습니까?' },
    { key:'heating_corrective_action_knowledge', text:'종사자가 한계기준 이탈 시 실시해야 하는 개선조치 방법을 알고 있으며, 이탈 및 개선조치 내용이 기록되고 있습니까?' },
  ]},
  { key: 'filtering', label: '여과공정', questions: [
    { key:'filtering_periodic_monitoring', text:'종사자가 주기적으로 cartridge filter의 파손유무, 이물 및 압력계의 압력을 확인하고, 그 내용을 기록하고 있습니까?' },
    { key:'filtering_pressure_gauge_calibration', text:'압력계는 연 1회 이상 검·교정이 이루어지고 있습니까?' },
    { key:'filtering_filter_damage_check_knowledge', text:'종사자가 필터의 파손유무 확인 방법을 정확히 알고 있습니까?' },
    { key:'filtering_pressure_check_knowledge', text:'종사자가 압력계의 압력을 정확하게 확인하는 방법을 알고 있습니까?' },
    { key:'filtering_corrective_action_knowledge', text:'종사자가 한계기준 이탈 시 실시해야 하는 개선조치 방법을 알고 있으며, 이탈 및 개선조치 내용이 기록되고 있습니까?' },
  ]},
  { key: 'bottleWashing', label: '세병공정', questions: [
    { key:'bottle_washing_periodic_monitoring', text:'종사자가 주기적으로 컴프레셔의 압력 및 세병 시간을 확인하고, 그 내용을 기록하고 있습니까?' },
    { key:'bottle_washing_pressure_gauge_calibration', text:'압력계는 연 1회 이상 검·교정이 이루어지고 있습니까?' },
    { key:'bottle_washing_time_knowledge', text:'종사자가 세병시간을 정확하게 알고 있습니까?' },
    { key:'bottle_washing_corrective_action_knowledge', text:'종사자가 한계기준 이탈 시 실시해야 하는 개선조치 방법을 알고 있으며, 이탈 및 개선조치 내용이 기록되고 있습니까?' },
  ]},
]);

export const HYGIENE_GROUPS = Object.freeze([
  { key:'pre_work', label:'작업 전 점검', cadence:'매일', questions:[
    ['개인위생','위생복장과 외출복장이 구분하여 보관되고 있는가?'], ['개인위생','종사자의 건강상태가 양호하고 개인장신구 등을 소지하지 않으며, 청결한 위생복장을 착용하고 작업하고 있는가?'],
    ['위생설비','위생설비(손세척·소독기 등) 중 이상이 있는 것이 있는가?'], ['방충방서','작업장은 밀폐가 잘 이루어지고 있으며, 방충시설(방충망 파손 등)에는 이상이 없다.'],
    ['설비도구','작업도구가 파손되거나 고장 난 제조설비가 없는가?'],
  ]},
  { key:'during_work', label:'작업 중 점검', cadence:'매일', questions:[
    ['공정관리','(구획이 안 된 작업장의 경우) 청결구역 작업과 일반구역 작업이 시간차를 두고 이루어지고 있는가?'], ['공정관리','완제품의 포장 상태가 양호한가?'], ['공정관리','모니터링 장비(온도계 등)는 사용 전·후 세척·소독을 실시하고 있는가?'],
  ]},
  { key:'post_work', label:'작업 후 점검', cadence:'매일', questions:[
    ['방충방서','작업장 주변의 음식물폐기물은 잘 정리되어 보관되어지고 있고, 주기적으로 반출되고 있는가?'], ['청소소독','작업장 바닥, 배수로, 위생시설, 제조설비(식품과 직접 닿는 부분)의 청소·소독 상태는 양호한가?'], ['점검','중요관리점(CCP) 점검표를 작성 주기에 맞게 작성하고, 한계기준 이탈 시 적절히 개선조치 하였는가?'],
  ]},
  { key:'incoming', label:'입고 시 점검', cadence:'입고 시', questions:[['입고검수','원·부재료 입고 시 시험성적서를 수령하거나, 육안검사를 실시하고 있는가?']]},
  { key:'weekly', label:'주간 점검', cadence:'매주 금요일', numeric:true, questions:[['청소소독','작업장 벽, 제조설비(제품과 직접 닿지 않는 부분)에 대한 청소·소독 상태는 양호한가?'],['청소소독','위생복 세탁은 실시하였는가?']]},
  { key:'monthly', label:'월간 점검', cadence:'매월 첫째 월요일', questions:[['청소','작업장 전체 청소 상태는 양호한가?'],['교육','종사자 위생교육을 실시하였는가?'],['검사','완제품에 대한 검사를 실시하였는가?'],['검증','중요관리공정(CCP) 검증표를 작성하였는가?']]},
  { key:'annual', label:'연간 점검', cadence:'매년', dates:true, questions:[] },
]);

const devices = (type, rows, categories) => rows.map(([number, location]) => ({ type, number, location, categories }));
export const PEST_GROUPS = Object.freeze([
  { key:'insectLights', label:'포충등', devices:devices('insect_light', [[1,'통로'],[2,'완제품실'],[3,'외포장실'],[4,'부자재실'],[5,'내포장실'],[6,'착유실'],[7,'원재료실'],[8,'가열실']], ['파리','나방','모기','하루살이','기타']) },
  { key:'cockroachTraps', label:'바퀴 트랩', devices:devices('cockroach_trap', [[1,'통로'],[2,'완제품실'],[3,'외포장실'],[4,'부자재실'],[5,'외포장실'],[6,'내포장실'],[7,'내포장실'],[8,'착유실'],[9,'원재료실'],[10,'원재료실'],[11,'착유실'],[12,'가열실']], ['바퀴','거미','개미','기타']) },
  { key:'mouseTraps', label:'쥐 트랩', devices:devices('mouse_trap', [[1,'통로 작은 출입문'],[2,'통로 큰 출입문'],[3,'원재료실 출입문'],[4,'가열실 출입문']], ['쥐','기타']) },
]);

export const COMPRESSED_AIR_FILTER_DEFAULTS = Object.freeze([1,2,3].map(number => ({
  number, installationLocation:'', purpose:'', productName:'', specification:'', installationDate:'',
  replacementCycle:'엘리먼트 없음 (싸이클론 방식)', replacementDate:'', managementNote:'엘리먼트 없음 (싸이클론 방식)',
})));
