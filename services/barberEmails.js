/**
 * barberEmails — what lands in a client's inbox.
 *
 * Every one of these is the only record the client has: they have no account,
 * no app, and no way to look their appointment up. So each email states the
 * time in words including the timezone, names the shop and the service, and
 * carries the one link that lets them manage or pay for it.
 *
 * Sent through utils/email (the shop's existing SMTP credentials). That helper
 * logs and returns false rather than throwing when SMTP is unset, so a missing
 * mail server can never lose a booking that is already on the books — the
 * appointment stands, the email is what fails.
 */
const { sendEmail } = require('../utils/email');
const { longLabel } = require('./barberSchedule');

const INK = '#22262b';        // charcoal, the same ink as the site
const RULE = '#d7dade';
const ACCENT = '#b8202e';     // barber-pole red

function usd(cents) { return '$' + (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * One letterhead for everything, so a reminder looks like it came from the same
 * shop as the confirmation. Inline styles only — every mail client that matters
 * still throws away a <style> block.
 */
function shell({ shop, heading, intro, rows = [], button, footNote }) {
  const rowHtml = rows.filter(Boolean).map(([k, v]) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid ${RULE};color:#6b727a;font:500 12px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;width:38%;vertical-align:top;">${esc(k)}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${RULE};color:${INK};font:400 15px/1.5 Georgia,'Times New Roman',serif;">${v}</td>
    </tr>`).join('');

  return `
  <div style="background:#eceef0;padding:32px 16px;">
    <div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid ${RULE};">
      <div style="background:${INK};padding:22px 28px;">
        <div style="color:#fff;font:700 20px/1 Georgia,'Times New Roman',serif;letter-spacing:.14em;text-transform:uppercase;">${esc(shop.name || 'Barbershop')}</div>
        <div style="color:#9aa3ac;font:400 12px/1.6 Helvetica,Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;margin-top:6px;">@${esc(shop.handle)}</div>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,${ACCENT} 0 33%,#fff 33% 66%,#1e4b8f 66% 100%);"></div>
      <div style="padding:28px;">
        <h1 style="margin:0 0 12px;color:${INK};font:700 22px/1.3 Georgia,'Times New Roman',serif;">${esc(heading)}</h1>
        <p style="margin:0 0 20px;color:#4d545c;font:400 15px/1.6 Helvetica,Arial,sans-serif;">${intro}</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">${rowHtml}</table>
        ${button ? `<a href="${esc(button.url)}" style="display:inline-block;background:${INK};color:#fff;padding:13px 26px;text-decoration:none;font:600 13px/1 Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;">${esc(button.label)}</a>` : ''}
        ${footNote ? `<p style="margin:22px 0 0;color:#8a929b;font:400 12px/1.6 Helvetica,Arial,sans-serif;">${footNote}</p>` : ''}
      </div>
      <div style="padding:16px 28px;background:#f5f6f7;border-top:1px solid ${RULE};color:#8a929b;font:400 12px/1.6 Helvetica,Arial,sans-serif;">
        ${esc(shop.name || '')}${shop.address ? ' &middot; ' + esc(shop.address) : ''}${shop.phone ? ' &middot; ' + esc(shop.phone) : ''}
      </div>
    </div>
  </div>`;
}

/** The rows every appointment email shares. */
function bookingRows(shop, booking) {
  return [
    ['When', `<strong>${esc(longLabel(booking.startsAt, shop.timezone))}</strong>`],
    ['Service', esc(booking.serviceName) + ` <span style="color:#8a929b;">(${booking.durationMin} min)</span>`],
    ['Price', usd(booking.priceCents)],
    shop.address ? ['Where', esc(shop.address)] : null,
    booking.notes ? ['Notes', esc(booking.notes)] : null
  ];
}

/** Booked by the client themselves. */
function clientConfirmation({ shop, booking, manageUrl, payUrl }) {
  return sendEmail({
    to: booking.clientEmail,
    subject: `You're booked — ${longLabel(booking.startsAt, shop.timezone)}`,
    html: shell({
      shop,
      heading: `See you ${esc(booking.clientName.split(' ')[0] || 'soon')}.`,
      intro: `Your appointment at <strong>${esc(shop.name)}</strong> is confirmed. Here it is in writing.`,
      rows: bookingRows(shop, booking),
      button: payUrl ? { url: payUrl, label: 'Pay for this appointment' } : { url: manageUrl, label: 'View or cancel' },
      footNote: payUrl
        ? `Paying ahead is optional — you can settle in the chair. <a href="${esc(manageUrl)}" style="color:${INK};">View or cancel your appointment</a>.`
        : 'Need to change it? Use the link above. Please give as much notice as you can.'
    })
  });
}

/** Put on the books by the barber — the "I've penciled you in" note. */
function bookedByBarber({ shop, booking, manageUrl, payUrl }) {
  return sendEmail({
    to: booking.clientEmail,
    subject: `${shop.name}: your appointment — ${longLabel(booking.startsAt, shop.timezone)}`,
    html: shell({
      shop,
      heading: 'You are on the books.',
      intro: `${esc(shop.name)} has scheduled your appointment. If the time does not work, use the link below and pick another.`,
      rows: bookingRows(shop, booking),
      button: payUrl ? { url: payUrl, label: 'Pay now' } : { url: manageUrl, label: 'View or cancel' },
      footNote: `<a href="${esc(manageUrl)}" style="color:${INK};">Manage this appointment</a>`
    })
  });
}

/** The bill. A single Stripe Checkout link, priced by the barber. */
function invoice({ shop, booking, amountCents, description, payUrl }) {
  return sendEmail({
    to: booking.clientEmail,
    subject: `${shop.name}: ${usd(amountCents)} due`,
    html: shell({
      shop,
      heading: 'Your bill.',
      intro: `${esc(shop.name)} has sent you a bill for <strong>${usd(amountCents)}</strong>. Card, Apple Pay and Google Pay all work.`,
      rows: [
        ['Amount', `<strong>${usd(amountCents)}</strong>`],
        ['For', esc(description || booking.serviceName)],
        ['Appointment', esc(longLabel(booking.startsAt, shop.timezone))]
      ],
      button: { url: payUrl, label: `Pay ${usd(amountCents)}` },
      footNote: 'Payment is handled by Stripe. This shop never sees your card details.'
    })
  });
}

/** Paid — sent from the verified webhook, never from the client's word for it. */
function paymentReceipt({ shop, booking, amountCents }) {
  return sendEmail({
    to: booking.clientEmail,
    subject: `Payment received — ${usd(amountCents)} to ${shop.name}`,
    html: shell({
      shop,
      heading: 'Paid. Thank you.',
      intro: `We have received <strong>${usd(amountCents)}</strong>. Nothing else is owed for this appointment.`,
      rows: bookingRows(shop, booking),
      footNote: 'Stripe has emailed you a receipt as well.'
    })
  });
}

function cancellation({ shop, booking, by, rebookUrl }) {
  return sendEmail({
    to: booking.clientEmail,
    subject: `Cancelled — ${longLabel(booking.startsAt, shop.timezone)}`,
    html: shell({
      shop,
      heading: 'Appointment cancelled.',
      intro: by === 'barber'
        ? `${esc(shop.name)} has had to cancel this appointment. Sorry for the trouble — you can pick a new time below.`
        : 'This appointment has been cancelled and the time is free again.',
      rows: bookingRows(shop, booking),
      button: { url: rebookUrl, label: 'Book another time' }
    })
  });
}

/** The barber's own copy, so the day sheet arrives without opening the panel. */
function barberAlert({ shop, booking, kind, to }) {
  if (!to) return Promise.resolve(false);
  const what = kind === 'cancelled' ? 'Cancellation' : kind === 'paid' ? 'Payment received' : 'New booking';
  return sendEmail({
    to,
    subject: `${what}: ${booking.clientName} — ${longLabel(booking.startsAt, shop.timezone)}`,
    html: shell({
      shop,
      heading: what + '.',
      intro: `<strong>${esc(booking.clientName)}</strong>${booking.clientPhone ? ' &middot; ' + esc(booking.clientPhone) : ''} &middot; ${esc(booking.clientEmail)}`,
      rows: bookingRows(shop, booking)
    })
  });
}

module.exports = {
  clientConfirmation, bookedByBarber, invoice, paymentReceipt,
  cancellation, barberAlert, usd, esc
};
