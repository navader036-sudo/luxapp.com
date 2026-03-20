const { google } = require('googleapis');
require('dotenv').config();

const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
);

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Agrega un evento a Google Calendar
 * @param {string} summary - Título del evento
 * @param {string} startTime - ISO String de inicio
 * @param {string} endTime - ISO String de fin
 * @param {string} description - Descripción opcional
 */
async function addCalendarEvent(summary, startTime, endTime, description = '') {
    try {
        const event = {
            summary,
            description,
            start: { dateTime: startTime, timeZone: 'America/Caracas' },
            end: { dateTime: endTime, timeZone: 'America/Caracas' },
        };

        const response = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            resource: event,
        });

        return response.data;
    } catch (error) {
        console.error('Error en Google Calendar:', error.message);
        throw error;
    }
}

/**
 * Lista eventos próximamente
 */
async function listUpcomingEvents() {
    try {
        const response = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            timeMin: new Date().toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return response.data.items;
    } catch (error) {
        console.error('Error listando eventos:', error.message);
        throw error;
    }
}

module.exports = { addCalendarEvent, listUpcomingEvents };
