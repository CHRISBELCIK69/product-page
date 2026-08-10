web: gunicorn server:app --bind 0.0.0.0:$PORT --timeout 60 --workers 2 --access-logfile - --error-logfile -
worker: python bot.py
