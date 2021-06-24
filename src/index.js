process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://d8d598e7826848ee8c13052d71adb6f4@sentry.cozycloud.cc/113'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: false,
  jar: true
})
const crypto = require('crypto')
const stream = require('stream')
const cheerio = require('cheerio')
const moment = require('moment')

const BASE_URL = 'https://api.lamutuellegenerale.fr'
const API_KEY = 'l7xx7e96b9de59df491a8d4c79be999e7c87'
const OIDC_CLIENT_ID = '066e0672-4b28-422d-aa44-ef42d0aad64a'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const token = await authenticate(fields.login, fields.password)
  token.golden_id = JSON.parse(atob(token.id_token.split('.')[1])).sub[0].id
  log('info', 'Successfully logged in')
  log('debug', token, 'Token')

  log('info', 'Fetching the list of refunds')
  const refunds = await request(
    `${BASE_URL}/espaceadherent/V1/mesremboursements/`,
    {
      json: true,
      headers: {
        'api-key': API_KEY,
        Authorization: `${token.token_type} ${token.access_token}`,
        idPersonneUtilisateur: token.golden_id,
        appRequestCode: 'EspaceAdherent'
      }
    }
  )

  log('info', 'Parsing list of bills')
  const documents = await getBillsFromRefunds(refunds, token)

  log('info', documents, 'Saving data to Cozy')
  await saveBills(documents, fields, {
    identifiers: ['la mutuelle gen']
  })
}

async function authenticate(username, password) {
  // prepare code_challenge
  const code_verifier = generateRandom(43)
  const code_challenge = btoa(
    crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('hex')
  )

  // call to /oidc/authorize
  const redirect_url = `https://adherent.lamutuellegenerale.fr/&code_challenge=${code_challenge}&code_challenge_method=S256`
  var response = await request(
    `${BASE_URL}/oidc/authorize?response_type=code&scope=openid&client_id=${OIDC_CLIENT_ID}&state=Any-state-5s5ze8g85d&redirect_uri=${redirect_url}`,
    {
      resolveWithFullResponse: true
    }
  )
  const params = extractParams(response.request.uri.search)
  const oidcLoginUri = response.request.uri.href

  // call to oidc/login
  response = await request.post(oidcLoginUri, {
    form: {
      sessionID: params['sessionID'],
      sessionData: '',
      username: username,
      password: password,
      state: 'submit'
    },
    transform: body => cheerio.load(body)
  })

  // parse form
  const [action, inputs] = parseForm(response, 'form', oidcLoginUri)

  // request form
  response = await request.post({
    uri: require('url').resolve(oidcLoginUri, action),
    method: 'POST',
    form: { ...inputs },
    transform: (body, response) => [cheerio.load(body), response],
    headers: {
      Referer: oidcLoginUri
    }
  })

  // extract returned code
  const code = extractParams(response[1].socket._httpMessage.path)['code']
  log('debug', code, 'code')

  // get token from the code
  response = request.post(`${BASE_URL}/oidc/token`, {
    resolveWithFullResponse: true,
    json: true,
    form: {
      grant_type: 'authorization_code',
      code: code,
      client_id: OIDC_CLIENT_ID,
      code_verifier: code_verifier,
      redirect_uri: 'https://adherent.lamutuellegenerale.fr/'
    },
    headers: {
      'api-key': API_KEY
    },
    transform: body => body
  })

  return response
}

function generateRandom(e = 5) {
  let t = ''
  const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'
  for (let i = 0; i < e; i++)
    t += n.charAt(Math.floor(Math.random() * n.length))
  return t
}

function atob(str) {
  return Buffer.from(str, 'base64').toString('binary')
}

function btoa(str) {
  if (str instanceof Buffer) {
    return str.toString('base64')
  } else {
    return Buffer.from(str.toString(), 'binary').toString('base64')
  }
}

function extractParams(url) {
  const params = {}
  url.replace(/[?&]+([^=&]+)=([^&]*)/gi, function(m, key, value) {
    params[key] = value
  })
  return params
}

function parseForm($, formSelector, currentUrl) {
  const form = $(formSelector).first()
  const action = form.attr('action') || currentUrl

  if (!form.is('form')) {
    const err = 'element matching `' + formSelector + '` is not a `form`'
    log('error', err)
    throw new Error('INVALID_FORM')
  }

  const inputs = {}
  const arr = form.serializeArray()

  for (let input of arr) {
    inputs[input.name] = input.value
  }

  return [action, inputs]
}

function decodePdf(encodedPdf) {
  let n = atob(encodedPdf)
  const bufferStream = new stream.PassThrough()
  for (let r = 0; r < n.length; r += 512) {
    let e = n.slice(r, r + 512)
    let t = new Array(e.length)
    for (let n = 0; n < e.length; n++) t[n] = e.charCodeAt(n)
    let s = new Uint8Array(t)
    bufferStream.write(s)
  }
  return bufferStream
}

async function getBillsFromRefunds(refunds, token) {
  const monthToBills = {}

  for (let refund of refunds.remboursements) {
    const refundDetail = await request(
      `${BASE_URL}/espaceadherent/V1/mesremboursements/${refund.id}?mock=false`,
      {
        json: true,
        headers: {
          'api-key': API_KEY,
          Authorization: `${token.token_type} ${token.access_token}`,
          idPersonneUtilisateur: token.golden_id,
          appRequestCode: 'EspaceAdherent'
        }
      }
    )

    const month = refund.dateVersement.substring(0, 7)
    var bill = monthToBills[month]
    if (bill === undefined) {
      bill = {
        amount: 0,
        groupAmount: 0,
        // originalAmount: 0,
        thirdPartyRefund: 0,
        socialSecurityRefund: 0,
        subType: refundDetail.remboursement.libelleCategoriePrestation
      }
      monthToBills[month] = bill
    }
    bill.amount += refundDetail.remboursement.coutPrestation
    bill.socialSecurityRefund += refundDetail.remboursement.montantVerseRO
    if (refundDetail.remboursement.tiersPayant) {
      bill.thirdPartyRefund += refundDetail.remboursement.montantVerseLMG
    } else {
      bill.groupAmount += refundDetail.remboursement.montantVerseLMG
    }
    if (bill.subType !== refundDetail.remboursement.libelleCategoriePrestation)
      bill.subType = 'Multiple'
  }

  let bills = []
  for (let monthKey in monthToBills) {
    const momentDate = moment(monthKey)
    let bill = {
      fetchFile: async function(d) {
        return request(
          `${BASE_URL}/espaceadherent/V1/mesremboursements/edition?debutPeriode=${momentDate.format(
            'YYYY-MM-DD'
          )}&finPeriode=${momentDate
            .endOf('month')
            .format('YYYY-MM-DD')}&tri=DATE_PAIEMENT&mock=false`,
          {
            json: true,
            form: {
              debutPeriode: '2021-04-01',
              finPeriode: '2021-04-30',
              tri: 'DATE_PAIEMENT',
              mock: 'false'
            },
            headers: {
              'api-key': API_KEY,
              Authorization: `${token.token_type} ${token.access_token}`,
              idPersonneUtilisateur: token.golden_id,
              appRequestCode: 'EspaceAdherent'
            }
          }
        ).then(e => decodePdf(e.edition))
      },
      date: new Date(monthKey),
      isThirdPartyPayer: monthToBills[monthKey].groupAmount == 0,
      groupAmount: monthToBills[monthKey].groupAmount,
      subtype: monthToBills[monthKey].subtype,
      socialSecurityRefund: monthToBills[monthKey].socialSecurityRefund,
      amount: monthToBills[monthKey].amount,
      filename: monthKey + '_lamutuellegenerale.pdf',
      vendor: 'lamutuellegenerale',
      type: 'health_costs',
      currency: '€',
      isRefund: true,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }
    bills.push(bill)
  }
  return bills
}
