#!/usr/bin/env node

import fetch from "node-fetch";
import cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const EMAIL = process.env.EMAIL
const PASSWORD = process.env.PASSWORD
const SCHEDULE_ID = process.env.SCHEDULE_ID
const FACILITY_ID = process.env.FACILITY_ID
const LOCALE = process.env.LOCALE
const REFRESH_DELAY_MIN = 30
const REFRESH_DELAY_MAX = 35
let RESCHEDULING = true

const BASE_URI = `https://ais.usvisa-info.com/${LOCALE}/niv`

async function main(currentBookedDate) {
  if (!currentBookedDate) {
    log(`Invalid current booked date: ${currentBookedDate}`)
    process.exit(1)
  }

  log(`Initializing with current date ${currentBookedDate}`)

  try {
    const sessionHeaders = await login()

    while(RESCHEDULING) {
      const date = await checkAvailableDate(sessionHeaders)

      if (!date) {
        log("no dates available")
      } else if (date > currentBookedDate) {
        log(`nearest date is further than already booked (${currentBookedDate} vs ${date})`)
      } else {
        const time = await checkAvailableTime(sessionHeaders, date)

        if (!time) {
          log(`no available time slots for date ${date}`)
        } else {
          await book(sessionHeaders, date, time).then(response => {
            log('Response status:', response.status);
            log('Response status text:', response.statusText);
            
            // Log response headers
            log('Response headers:');
            for (const [key, value] of response.headers.entries()) {
              log(`${key}: ${value}`);
            }
            return response;
          })
          .catch(error => {
            log('Error in booking request:', error);
          });

          log(`booked time at ${date} ${time}`)
          currentBookedDate = date
          RESCHEDULING = false
        }
      }

      const delay = randomIntFromInterval(REFRESH_DELAY_MIN, REFRESH_DELAY_MAX)
      log(`waiting ${delay} seconds before next check`)

      await sleep(delay)
    }

  } catch(err) {
    console.error(err)
    if (err.message === "Service Unavailable (503)") {
      log("Service Unavailable, waiting 900 seconds before retry")
      await sleep(900)
    }
    log("Trying again")
    main(currentBookedDate)
  }
}

async function login() {
  log(`Logging in`)

  const anonymousResponse = await fetch(`${BASE_URI}/users/sign_in`, {
    headers: {
      "User-Agent": "",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
    },
  });

  if (anonymousResponse.status === 503) {
    throw new Error("Service Unavailable (503)");
  }

  const anonymousHeaders = await extractHeaders(anonymousResponse);

  const loginResponse = await fetch(`${BASE_URI}/users/sign_in`, {
    "headers": Object.assign({}, anonymousHeaders, {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    "method": "POST",
    "body": new URLSearchParams({
      'utf8': '✓',
      'user[email]': EMAIL,
      'user[password]': PASSWORD,
      'policy_confirmed': '1',
      'commit': 'Acessar'
    }),
  });

  return Object.assign({}, anonymousHeaders, {
    'Cookie': extractRelevantCookies(loginResponse)
  });
}

function checkAvailableDate(headers) {
  return fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`, {
    "headers": Object.assign({}, headers, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store"
  })
    .then(r => r.json())
    .then(r => handleErrors(r))
    .then(d => d.length > 0 ? d[0]['date'] : null)

}

function checkAvailableTime(headers, date) {
  return fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${FACILITY_ID}.json?date=${date}&appointments[expedite]=false`, {
    "headers": Object.assign({}, headers, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store",
  })
    .then(r => r.json())
    .then(r => handleErrors(r))
    .then(d => d['business_times'][0] || d['available_times'][0])
}

function handleErrors(response) {
  const errorMessage = response['error']

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return response
}

async function book(headers, date, time) {
  const url = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`

  const prepareResponse = await fetch(url, { "headers": headers });
  const newHeaders = await extractHeaders(prepareResponse);

  return fetch(url, {
    "method": "POST",
    "redirect": "follow",
    "headers": Object.assign({}, newHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    "body": new URLSearchParams({
      'utf8': '✓',
      'authenticity_token': newHeaders['X-CSRF-Token'],
      'confirmed_limit_message': '1',
      'use_consulate_appointment_capacity': 'true',
      'appointments[consulate_appointment][facility_id]': FACILITY_ID,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    }),
  })
}

async function extractHeaders(res) {
  const cookies = extractRelevantCookies(res)

  const html = await res.text()
  const $ = cheerio.load(html);
  const csrfToken = $('meta[name="csrf-token"]').attr('content')

  return {
    "Cookie": cookies,
    "X-CSRF-Token": csrfToken,
    "Referer": BASE_URI,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive'
  }
}

function extractRelevantCookies(res) {
  const parsedCookies = parseCookies(res.headers.get('set-cookie'))
  return `_yatri_session=${parsedCookies['_yatri_session']}`
}

function parseCookies(cookies) {
  const parsedCookies = {}

  cookies.split(';').map(c => c.trim()).forEach(c => {
    const [name, value] = c.split('=', 2)
    parsedCookies[name] = value
  })

  return parsedCookies
}

function sleep(s) {
  return new Promise((resolve) => {
    setTimeout(resolve, s * 1000);
  });
}

function randomIntFromInterval(min, max) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function log(message) {
  console.log(`[${new Date().toISOString()}]`, message)
}

const args = process.argv.slice(2);
const currentBookedDate = args[0]
main(currentBookedDate)
