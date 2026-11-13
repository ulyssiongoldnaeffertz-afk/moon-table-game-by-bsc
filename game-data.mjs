export const GAMES = {
  wolf: { name: '狼人杀', min: 6, max: 12, subtitle: '夜间行动 · 白天推理', image: 'werewolf.webp' },
  avalon: { name: '阿瓦隆', min: 5, max: 10, subtitle: '秘密阵营 · 圆桌任务', image: 'avalon.webp' }
};

export const WOLF_KEYS = ['wolf', 'villager', 'seer', 'witch', 'guard', 'hunter'];
export const WOLF_BOARDS = {
  6: [2, 2, 1, 1, 0, 0],
  7: [2, 2, 1, 1, 0, 1],
  8: [2, 3, 1, 1, 1, 0],
  9: [3, 3, 1, 1, 0, 1],
  10: [3, 3, 1, 1, 1, 1],
  11: [3, 4, 1, 1, 1, 1],
  12: [4, 4, 1, 1, 1, 1]
};
export const NIGHT_SCHEDULE = {
  180: [90, 160, 180],
  300: [150, 280, 300]
};

export const AVALON_COUNTS = {
  5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4]
};
export const AVALON_TASKS = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};
export const AVALON_PRESETS = {
  base: { name: '基础圆桌', good: [], evil: [] },
  masks: { name: '真假梅林', good: ['percival'], evil: ['morgana'] },
  hidden: { name: '暗影骑士', good: ['percival'], evil: ['morgana', 'mordred'] },
  outcast: { name: '孤影奥伯伦', good: ['percival'], evil: ['oberon'] },
  full: { name: '完整传说', good: ['percival'], evil: ['morgana', 'mordred', 'oberon'] }
};

export const ROLES = {
  wolf: {
    name: '狼人', side: '狼人', sign: '☾',
    ability: '认识狼队。每夜可私聊、选择并锁定一张刀票。',
    goal: '完成本局所选的屠城或屠边胜利条件。',
    how: '第一阶段选目标，队内可见暂选和锁票状态。提交后可以继续聊天。',
    tip: '锁定后无法改票。未锁定的暂选按弃权处理。'
  },
  villager: {
    name: '平民', side: '好人', sign: '◈',
    ability: '白天发言并参加放逐投票。夜间可完成本机练习。',
    goal: '通过发言和投票放逐所有狼人。',
    how: '夜间打开策略、术语或案例。白天听完发言再决定投票。',
    tip: '记录可复核的发言和票型，区分事实与推测。'
  },
  seer: {
    name: '预言家', side: '好人', sign: '✧',
    ability: '每夜查验一名活人，结果只有阵营。',
    goal: '把可核验的查验信息带给好人并放逐狼人。',
    how: '第一阶段选目标，确认锁定后查看阵营。查验记录可在身份页重看。',
    tip: '看到好人阵营时，仍无法得知对方的具体职业。'
  },
  witch: {
    name: '女巫', side: '好人', sign: '❖',
    ability: '独立持有一瓶解药和一瓶毒药，每晚最多用一瓶。',
    goal: '用药帮助好人存活并放逐狼人。',
    how: '第二阶段查看狼刀目标，选择解药、毒药或放弃。仅第一晚可自救。',
    tip: '同守同救会使狼刀照常生效。毒药优先，守护和解药均无法抵消。'
  },
  guard: {
    name: '守卫', side: '好人', sign: '⬡',
    ability: '每夜可守护一名活人或放弃守护。',
    goal: '在不公开守护目标的情况下保护好人。',
    how: '第一阶段选目标。可自守，连续两晚不能守同一人。',
    tip: '守护只影响狼刀，且与解药同时生效时会抵消。'
  },
  hunter: {
    name: '猎人', side: '好人', sign: '✦',
    ability: '被狼刀击杀或白天被放逐时可带走一名目标。',
    goal: '根据发言和票型谨慎选择目标，帮助好人放逐狼人。',
    how: '看到开枪资格后选择目标或放弃。夜间预提交的结果在天亮公布。',
    tip: '毒死与被猎人带走都无法触发技能。没有提交的夜间开枪视为放弃。'
  },
  merlin: {
    name: '梅林', side: '好人', sign: '✧',
    ability: '开局识别除莫德雷德以外的坏人座位，包括奥伯伦。',
    goal: '让三次任务成功并躲过刺杀。',
    how: '查看初始情报。用可以公开解释的理由讨论任务名单。',
    tip: '直接指出所有坏人可能让刺客锁定你的身份。'
  },
  loyal: {
    name: '亚瑟的忠臣', side: '好人', sign: '◈',
    ability: '没有开局阵营情报，入队只能出成功牌。',
    goal: '让三次任务成功并保护梅林。',
    how: '参与组队投票，入队时提交成功牌。',
    tip: '一次任务成功也可能有坏人藏在队内。'
  },
  percival: {
    name: '派西维尔', side: '好人', sign: '⬡',
    ability: '看到梅林候选座位。有莫甘娜时会看到两名候选。',
    goal: '辨别真梅林，协助完成三次任务并保护梅林。',
    how: '结合提名和失败牌数量判断候选。',
    tip: '候选列表按座位展示，顺序不代表身份。'
  },
  assassin: {
    name: '刺客', side: '邪恶', sign: '✦',
    ability: '认识可互认的坏人。三次任务成功后拥有一次刺杀机会。',
    goal: '促成三次失败、五次连续否决，或在刺杀阶段命中梅林。',
    how: '入队可出成功或失败牌。刺杀时选一名其他玩家并确认。',
    tip: '刺杀确认后立即结算。'
  },
  minion: {
    name: '莫德雷德的爪牙', side: '邪恶', sign: '◆',
    ability: '认识除奥伯伦外的邪恶同伴，可在任务中出失败牌。',
    goal: '协助邪恶阵营赢得对局。',
    how: '查看同伴，投票并在入队后秘密出牌。',
    tip: '失败牌只公布数量，观察队伍组成再决定出牌。'
  },
  morgana: {
    name: '莫甘娜', side: '邪恶', sign: '❖',
    ability: '在派西维尔的情报中与梅林一起出现，认识可互认的坏人。',
    goal: '误导派西维尔并帮助邪恶阵营取胜。',
    how: '利用提名和讨论建立可信的发言，入队可出成功或失败牌。',
    tip: '派西维尔无法通过候选名单的顺序分辨梅林。'
  },
  mordred: {
    name: '莫德雷德', side: '邪恶', sign: '⬡',
    ability: '避开梅林的初始情报，认识除奥伯伦外的邪恶同伴。',
    goal: '利用信息差帮助邪恶阵营取胜。',
    how: '在提名、组队投票和任务中行动，入队可出失败牌。',
    tip: '任务票统计仍可能让玩家推断你的阵营。'
  },
  oberon: {
    name: '奥伯伦', side: '邪恶', sign: '☾',
    ability: '与其他坏人互不认识，但会被梅林识别。',
    goal: '独立帮助邪恶阵营取胜。',
    how: '依靠公开队伍和票型判断局势。入队可出成功或失败牌。',
    tip: '留意多人同时出失败牌时会暴露更多队伍信息。'
  }
};

export const PRACTICE = {
  wolf: {
    background: '你和同伴必须在夜幕中做出一个共同决定。',
    tactic: '白天给出能被场上事实解释的判断。夜间先对齐选择，再锁定刀票。',
    mistake: '把暂选当作有效刀票，或误以为每名狼人都会各击杀一人。',
    term: '刀票', meaning: '狼人提交的夜间目标票',
    case: '两张有效刀票分别投给不同玩家，且没有其他刀票。',
    options: ['两人都出局', '等概率抽取一个目标', '按房主选择'],
    answer: 1, feedback: '并列最高票由服务端等概率抽取一个狼刀目标。',
    prompt: '写一句明天可以公开解释的投票理由。'
  },
  villager: {
    background: '你是村庄的一员。白天的发言、提问和选票是你的信息来源。',
    tactic: '把原话和推测分开。先复述对方观点，再指出前后不一致的地方。',
    mistake: '把突然改口或积极控场直接等同于狼。好人也会随信息改变判断。',
    term: '票型', meaning: '一轮公开投票的投票关系',
    case: '一名玩家先怀疑 2 号，之后改投 5 号，却没有解释变化。',
    options: ['记下两次说法并请他解释', '直接认定他是狼人', '忽略所有票型'],
    answer: 0, feedback: '追问变化背后的信息，再把回答和公开选票一起比较。',
    prompt: '写下明天的一个问题，再写出你准备追问的依据。'
  },
  seer: {
    background: '你的查验能为圆桌发言提供一条确定的阵营信息。',
    tactic: '优先查验会影响白天多数决策、但尚无可靠信息的玩家。',
    mistake: '把好人查验结果说成具体职业，或者把自己的推测混进查验。',
    term: '金水', meaning: '查验为好人的玩家',
    case: '你查到 4 号是好人。有人追问 4 号是不是女巫。',
    options: ['确认是女巫', '公开 4 号的装备', '只能确认好人阵营'],
    answer: 2, feedback: '你的结果只有好人与狼人两个阵营。',
    prompt: '用两句话区分你的查验结论和发言推测。'
  },
  witch: {
    background: '药剂数量有限。每次用药都会改变接下来几夜的选择。',
    tactic: '先确认本夜狼刀对象，再考虑场上信息和还剩几瓶药。',
    mistake: '以为解药能救毒药，或把药剂留到已失去资格后再用。',
    term: '同守同救', meaning: '守护与解药同时作用于狼刀目标而失效',
    case: '同一名被狼刀的玩家获得守护和解药，且无人对其用毒。',
    options: ['玩家因狼刀死亡', '玩家获得两次保护', '随机决定死活'],
    answer: 0, feedback: '本桌规则下守护和解药冲突，狼刀生效。',
    prompt: '写下一条你愿意用毒药的判断标准。'
  },
  guard: {
    background: '守卫的行动默默生效。判断下一晚谁容易成为狼刀目标。',
    tactic: '比较公开发言带来的目标压力，记住上一晚的守护位置。',
    mistake: '连续两晚守同一人，或以为守护能够挡毒。',
    term: '空守', meaning: '本夜主动放弃守护',
    case: '你第一晚守了 3 号，第二晚主动空守。第三晚还想守 3 号。',
    options: ['始终禁止再守 3 号', '第三晚可以守 3 号', '第三晚必须守自己'],
    answer: 1, feedback: '空守打断连续守护，第三晚可以重新选 3 号。',
    prompt: '列出两个可能被刀的位置，并写下各自原因。'
  },
  hunter: {
    background: '猎人的技能只在符合特定死亡原因时出现。',
    tactic: '提前从公开发言和投票中列出最可疑的对象，也保留放弃的选择。',
    mistake: '把狼刀暂选当作死亡，或在没有足够线索时随意带人。',
    term: '放逐', meaning: '白天投票结算后的出局',
    case: '同一晚你同时中了狼刀和女巫毒药。',
    options: ['可以开枪一次', '能开枪两次', '毒药优先，不能开枪'],
    answer: 2, feedback: '同夜多因冲突以毒药为先，没有开枪资格。',
    prompt: '写下你会选择放弃开枪的一个场景。'
  }
};

export const PHASE_NAMES = {
  sheriff_signup:'警长报名',sheriff_speech:'警上发言',sheriff_vote:'警长投票',sheriff_pk_speech:'警长PK发言',sheriff_pk_vote:'警长PK投票',badge_transfer:'警徽移交',last_words:'遗言阶段',lady_lake:'湖中仙女',lady_result:'仙女私有结果',
  identity: '查看身份',
  night_one: '夜间第一阶段', night_two: '夜间第二阶段', night_three: '夜间确认',
  dawn: '天亮播报', discussion: '白天讨论', day_vote: '放逐投票',
  pk_discussion: '平票 PK 发言', pk_vote: 'PK 投票', day_hunter: '猎人结算',
  day_result: '放逐结算',
  nomination: '队长提名', team_vote: '组队投票', mission: '任务出牌',
  mission_result: '任务结算', assassination: '刺杀梅林',
  ended: '对局结束'
};

export const ROOM_STATUS = {
  idle: '空闲', waiting: '等待玩家', ready: '等待准备', playing: '游戏进行中',
  ended: '游戏已结束', resetting: '重置中'
};
