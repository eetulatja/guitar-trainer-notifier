import Promise from 'bluebird';
import request from 'request-promise';
import moment from 'moment';
import _ from 'lodash';
import 'colors';
import Koa from 'koa';
import KoaRouter from 'koa-router';
import mailgun from 'mailgun-js';
import config from 'config';


const mailgunClient = mailgun({
	apiKey: config.get('mailgun.apiKey'),
	domain: config.get('mailgun.domain'),
});


let previousLessons = [];

const requests = [];


function printWithTime(text) {
	const timeText = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
	process.stdout.write(`${timeText} ${text}`);
}

async function login() {
	await request({
		url: config.get('superSaas.urls.frontpage'),
		jar: true,
	});

	const text = await request({
		url: config.get('superSaas.urls.login'),
		method: 'POST',
		form: {
			name: config.get('superSaas.credentials.name'),
			password: config.get('superSaas.credentials.password'),
		},
		jar: true,
		followAllRedirects: true,
	});
}

async function getLessons(verbose = true) {
	if (verbose) {
		printWithTime('Fetching lessons...');
	}

	const now = moment();
	const after2Months = moment(now).add(2, 'month');

	const response = await request({
		url: config.get('superSaas.urls.reservations'),
		qs: {
			afrom: now.format('YYYY-MM-DD HH:mm'),
			ato: after2Months.format('YYYY-MM-DD HH:mm'),
		},
		jar: true,
	});

	const {
		app: rawLessons,
		mine: myLessonIds,
	} = JSON.parse(response);

	const lessons = rawLessons.map(rawLesson => {
		const id = rawLesson[2];
		const startDate = moment(1000 * rawLesson[0]).utcOffset(0);
		const endDate = moment(1000 * rawLesson[1]).utcOffset(0);
		const typeName = rawLesson[7];
		const hasSpace = rawLesson[3] === -1 && rawLesson[4] === -1;
		const reservation = _.includes(myLessonIds, id);

		const lesson = {
			id,
			startDate,
			endDate,
			typeName,
			hasSpace,
			reservation,
		};

		return lesson;
	});

	if (verbose) {
		process.stdout.write(`DONE Fetched ${lessons.length} lessons.\n`);
	}

	return lessons;
}

function printLessons(lessons) {
	const lessonsByDate = _.groupBy(lessons, ({ startDate }) => startDate.format('YYYY-MM-DD'));

	for (const [ date, lessons ] of Object.entries(lessonsByDate)) {
		console.log(date);
		for (let { typeName, reservation, hasSpace } of lessons) {
			if (!hasSpace) {
				typeName = typeName.grey;
			}
			const reserved = reservation ? 'X'.green : ' ';
			console.log(`  ${reserved} ${typeName}`);
		}
	}
}

async function getNewLessons(notifyFromOwnActions = false) {
	printWithTime('Refreshing lessons...');

	const newLessons = await getLessons(false);

	const freedLessons = [];
	for (const newLesson of newLessons) {
		const oldLesson = _.find(previousLessons, ({ id }) => newLesson.id === id);

		let shouldNotify = false;

		if (!oldLesson) {
			shouldNotify = true;
		}
		else {
			const wasFreed = !oldLesson.hasSpace && newLesson.hasSpace;
			shouldNotify = wasFreed;

			if (!notifyFromOwnActions) {
				const reserved = oldLesson.reservation || newLesson.reservation;
				shouldNotify &= !reserved;
			}
		}

		if (shouldNotify) {
			freedLessons.push(newLesson);
		}
	}

	previousLessons = newLessons;

	process.stdout.write(`DONE Fetched ${newLessons.length} lessons, ${freedLessons.length} lessons freed.\n`);

	if (freedLessons.length > 0) {
		await sendMail(freedLessons);
	}
}

async function startHttpServer() {
	printWithTime('Starting HTTP server...');

	const app = new Koa();
	const router = new KoaRouter();

	router.post('/refresh', async (ctx, next) => {
		const notifyFromOwnActions = (ctx.request.query.notify === 'always');

		await getNewLessons(notifyFromOwnActions);

		ctx.body = { message: 'Lessons reservation data refreshed.' };
	});

	app.use(router.routes());


	const port = config.get('server.port');

	await new Promise(resolve => app.listen(port, resolve));

	process.stdout.write('DONE\n');
}

async function sendMail(lessons) {
	printWithTime('Sending email...');

	const body = 'Freed lessons:\n\n' + _.chain(lessons)
		.groupBy(({ startDate }) => startDate.format('ddd D.M.'))
		.map((lessons, date) => {
			const lessonsText = lessons
				.map(({ typeName, startDate, endDate }) => {
					return `  ${startDate.format('HH:mm')} - ${endDate.format('HH:mm')} ${typeName}`;
				})
				.join('\n');

			return date + '\n' + lessonsText;
		})
		.join('\n\n')
		.value();

	const headers = config.get('mailgun.headers');

	const message = _.merge({ text: body }, headers);

	const response = await mailgunClient.messages().send(message);

	process.stdout.write('DONE\n');
}

function pollLoop() {
	const interval = Math.round((10 + 4 * Math.random() - 2) * 60 * 1000);

	setTimeout(async () => {
		await getNewLessons();

		pollLoop();
	}, interval);
}


async function main() {
	printWithTime('Logging in...');
	await login();
	process.stdout.write('DONE\n');

	previousLessons = await getLessons();

	await startHttpServer();

	pollLoop();
}

Promise.resolve(main()).done();
