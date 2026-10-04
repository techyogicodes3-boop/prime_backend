import nodemailer from 'nodemailer';
import {findListing} from './db.js';
export const mailConfigured = () => ['SMTP_HOST','MAIL_FROM','PRISM_NOTIFICATION_EMAIL','APP_ORIGIN'].every(key=>process.env[key]);
export const enquiryMailConfigured = () => ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','MAIL_FROM'].every(key=>process.env[key]);
export const whatsappNumber = () => /^\d{8,15}$/.test(process.env.PRISM_WHATSAPP_NUMBER || '') ? process.env.PRISM_WHATSAPP_NUMBER : '';
export const normalizeSmtpPassword = (host,password) => /^(smtp\.)?(gmail|googlemail)\.com$/i.test(String(host||'')) ? String(password||'').replace(/[\s-]/g,'') : String(password||'');
export const smtpTransportOptions = (environment=process.env) => {
  const secure=environment.SMTP_SECURE==='true';
  const options={host:environment.SMTP_HOST,port:Number(environment.SMTP_PORT||(secure?465:587)),secure,requireTLS:!secure,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000};
  if(environment.SMTP_USER)options.auth={user:environment.SMTP_USER,pass:normalizeSmtpPassword(environment.SMTP_HOST,environment.SMTP_PASSWORD)};
  return options;
};
export const createMailTransport = (environment=process.env) => nodemailer.createTransport(smtpTransportOptions(environment));
const mailTransport = () => createMailTransport();
export function whatsappLink(record) {
  if (!whatsappNumber()) return null;
  const message=`Hello Prism Edu Consultancy,\n\nI have submitted a ${record.type==='Properties Required'?'School Properties Requirement':'Property Listing'}.\n\nReference Number: ${record.reference}\nName: ${record.contactName}\nOrganization: ${record.ownerName || ''}\nLocation: ${record.location}\nRequired/Available Area: ${record.area} ${record.areaUnit}\nTransaction Preference: ${record.transaction}\nPhone Number: ${record.phone}\nShort Description: ${(record.summary || record.description).slice(0,180)}\n\nPlease review my submission and contact me.`;
  return `https://wa.me/${whatsappNumber()}?text=${encodeURIComponent(message)}`;
}
export async function sendEnquiryEmail(record,testTransport) {
  if (!enquiryMailConfigured()) return {sent:false,reason:'not_configured'};
  const transport=testTransport || mailTransport();
  const recipient=process.env.ENQUIRY_TO_EMAIL || 'info@prismedu.in';
  const text=[
    'A new enquiry was submitted through the Prism Edu website.',
    '',
    `Name: ${record.name}`,
    `Email: ${record.email || 'Not provided'}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `School / Organization: ${record.organization || 'Not provided'}`,
    `City / Location: ${record.location || 'Not provided'}`,
    `Enquiry Type: ${record.topic}`,
    '',
    'Message:',
    record.message,
    '',
    `Received: ${record.createdAt.toISOString()}`,
  ].join('\n');
  try {
    await transport.sendMail({from:process.env.MAIL_FROM,to:recipient,replyTo:record.email || undefined,subject:`New Prism Edu enquiry — ${record.topic}`,text});
    return {sent:true};
  } finally {
    if(!testTransport)transport.close();
  }
}
export async function deliverNotifications(db, testTransport) {
  if (!mailConfigured()) return;
  const transport=testTransport || createMailTransport();
  const jobs=await db.collection('notifications').find({status:{$in:['pending','failed']},attempts:{$lt:5},nextAttempt:{$lte:new Date()}}).limit(10).toArray();
  for (const job of jobs) {
    const item=await findListing(db,job.listingId); if (!item) continue;
    try {
      const fields=['type','reference','createdAt','contactName','ownerName','phone','whatsapp','email','location','city','district','state','area','areaUnit','propertyType','transaction','terms','description'];
      const text=fields.map(key=>`${key}: ${item[key] || ''}`).join('\n')+`\n\nAdmin review: ${process.env.APP_ORIGIN}/admin/school-properties?edit=${item.id}\n\nImages (admin login required until published):\n`+item.images.map(id=>`${process.env.APP_ORIGIN}/api/media/${id}`).join('\n');
      await transport.sendMail({from:process.env.MAIL_FROM,to:process.env.PRISM_NOTIFICATION_EMAIL,subject:`School Properties ${item.reference} — ${item.type}`,text});
      await db.collection('notifications').updateOne({_id:job._id},{$set:{status:'sent',updatedAt:new Date()},$inc:{attempts:1},$unset:{error:''}});
    } catch {
      await db.collection('notifications').updateOne({_id:job._id},{$set:{status:'failed',nextAttempt:new Date(Date.now()+60000*2**job.attempts),updatedAt:new Date(),error:'Email delivery failed; check server mail configuration.'},$inc:{attempts:1}});
    }
  }
  transport.close();
}
