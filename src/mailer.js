import nodemailer from 'nodemailer';

/**
 * 메일 발송. SMTP_URL 이 없으면 콘솔에 출력하는 개발용 모드로 동작한다.
 * 예) SMTP_URL=smtps://아이디:앱비밀번호@smtp.gmail.com:465
 */
export function createMailer(env = process.env, log = console) {
  if (!env.SMTP_URL) {
    return {
      configured: false,
      async send({ to, subject, text }) {
        log.info(`[mail:dev] to=${to} subject=${subject}\n${text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(env.SMTP_URL);
  const from = env.MAIL_FROM || 'MEET <no-reply@meet.local>';
  return {
    configured: true,
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
