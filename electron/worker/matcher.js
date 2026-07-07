/**
 * Form Field Semantic Matcher
 * 
 * Maps job application form fields to resume data using simple rules.
 * For v1: rule-based matching. For v2: LLM-powered matching.
 */

// Known field patterns → resume field mapping
const FIELD_PATTERNS = {
  name: ['姓名', '您的姓名', '真实姓名', 'full name', 'name'],
  phone: ['手机', '手机号', '电话', '联系方式', '联系电话', 'phone', 'mobile', 'tel'],
  email: ['邮箱', '电子邮件', 'email', 'e-mail', '电子邮箱'],
  education: ['学历', '最高学历', '教育程度', 'education', 'degree'],
  school: ['学校', '毕业院校', '院校', 'school', 'university', 'college'],
  major: ['专业', '所学专业', 'major', 'specialty'],
  graduation: ['毕业时间', '毕业年份', 'graduation'],
  experience: ['工作经验', '工作年限', 'experience', 'years of experience'],
  current_company: ['当前公司', '所在公司', 'current company', 'employer'],
  current_title: ['当前职位', '职位', 'current title', 'position', 'job title'],
  salary: ['期望薪资', '薪资要求', '薪资', 'salary', 'expected salary'],
  city: ['所在城市', '工作城市', '城市', 'city', 'location'],
  skills: ['技能', '专业技能', '技术栈', 'skills', 'technical skills'],
  self_intro: ['自我介绍', '个人优势', '自我评价', '自我介绍/优势', 'about me', 'introduction', 'summary'],
  project: ['项目经历', '项目经验', '项目', 'projects', 'project experience'],
  work_desc: ['工作经历', '工作描述', '工作内容', 'work experience', 'work description'],
};

/**
 * Match a form field label to a resume field
 * @param {string} fieldLabel - The label/placeholder/name of the form field
 * @param {object} resume - Resume data
 * @returns {object} { matched: true, field: 'salary', value: '25k-35k' } | { matched: false }
 */
function matchField(fieldLabel, resume, jobContext = {}) {
  const normalized = fieldLabel.toLowerCase().trim();

  for (const [resumeField, patterns] of Object.entries(FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      if (normalized.includes(pattern)) {
        const value = getResumeValue(resumeField, resume, jobContext);
        return { matched: true, field: resumeField, value };
      }
    }
  }

  return { matched: false };
}

function getResumeValue(field, resume, ctx) {
  switch (field) {
    case 'name': return resume.name || '';
    case 'phone': return resume.phone || '';
    case 'email': return resume.email || '';
    case 'education': return (resume.education || [])[0]?.degree || '本科';
    case 'school': return (resume.education || [])[0]?.school || '';
    case 'major': return (resume.education || [])[0]?.major || '';
    case 'graduation': return (resume.education || [])[0]?.graduation || '';
    case 'experience': return `${resume.work_history?.length || 0}年`;
    case 'current_company': return (resume.work_history || [])[0]?.company || '';
    case 'current_title': return (resume.work_history || [])[0]?.title || '';
    case 'salary':
      return resume.salary_min && resume.salary_max
        ? `${resume.salary_min}K-${resume.salary_max}K`
        : (resume.salary_min ? `${resume.salary_min}K以上` : '面议');
    case 'city': return resume.city || '';
    case 'skills': return (resume.skills || []).join('、');
    case 'self_intro':
      return generateSelfIntro(resume, ctx);
    case 'project':
      return (resume.work_history || [])
        .map(w => `${w.company}: ${w.title} (${w.start}-${w.end})${w.description ? ' - ' + w.description : ''}`)
        .join('\n');
    case 'work_desc':
      return (resume.work_history || [])
        .map(w => `${w.start}-${w.end} ${w.company} | ${w.title}${w.description ? ': ' + w.description : ''}`)
        .join('\n');
    default:
      return '';
  }
}

function generateSelfIntro(resume, ctx) {
  const name = resume.name || '';
  const skills = (resume.skills || []).slice(0, 8).join('、');
  const exp = resume.work_history?.length || 0;
  const recentJob = (resume.work_history || [])[0];
  const city = resume.city || '';

  let intro = '';
  if (name) intro += `我叫${name}，`;
  if (exp > 0) intro += `有${exp}年工作经验，`;
  if (skills) intro += `擅长${skills}。`;
  if (recentJob) intro += `最近在${recentJob.company}担任${recentJob.title}。`;
  if (city) intro += `目前在${city}。`;
  if (ctx?.title) intro += `对贵司的「${ctx.title}」岗位很感兴趣，期待进一步沟通。`;

  return intro || '期待与您进一步沟通';
}

module.exports = { matchField, FIELD_PATTERNS };
