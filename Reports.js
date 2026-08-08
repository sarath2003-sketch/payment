import React, { useState, useEffect } from 'react';
import { dashboard } from '../services/api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

function Reports() {
  const [month, setMonth] = useState('June 2026');
  const [report, setReport] = useState(null);
  const [monthlyCollection, setMonthlyCollection] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchReport();
  }, [month]);

  const fetchReport = async () => {
    try {
      setLoading(true);
      const [reportRes, monthlyRes] = await Promise.all([
        dashboard.getMonthlyReport(month),
        dashboard.getMonthlyCollection(),
      ]);
      setReport(reportRes.data);
      setMonthlyCollection(monthlyRes.data.reverse());
      setError('');
    } catch (error) {
      setError('Failed to load report');
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="container">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading report...</p>
        </div>
      </div>
    );
  }

  const pieData = report?.summary ? [
    { name: 'Collected', value: report.summary.total_collected },
    { name: 'Withdrawn', value: report.summary.total_withdrawn },
  ] : [];

  const COLORS = ['#10b981', '#f59e0b'];

  return (
    <div className="container">
      <div className="card">
        <div className="card-header">
          <h2>Reports & Analytics</h2>
          <button className="btn-primary" onClick={fetchReport}>🔄 Refresh</button>
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        <div className="form-group" style={{ marginBottom: '30px' }}>
          <label>Select Month:</label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ maxWidth: '300px' }}
          >
            <option>June 2026</option>
            <option>May 2026</option>
            <option>April 2026</option>
            <option>March 2026</option>
          </select>
        </div>

        {report && (
          <>
            {/* Monthly Summary */}
            <div className="grid">
              <div className="stat-box primary">
                <h3>Month</h3>
                <div className="value">{report.summary.month}</div>
              </div>
              <div className="stat-box success">
                <h3>Total Collected</h3>
                <div className="value">₹{report.summary.total_collected.toLocaleString('en-IN')}</div>
              </div>
              <div className="stat-box warning">
                <h3>Total Withdrawn</h3>
                <div className="value">₹{report.summary.total_withdrawn.toLocaleString('en-IN')}</div>
              </div>
              <div className="stat-box primary">
                <h3>Balance</h3>
                <div className="value" style={{ color: report.summary.balance >= 0 ? '#10b981' : '#ef4444' }}>
                  ₹{report.summary.balance.toLocaleString('en-IN')}
                </div>
              </div>
            </div>

            {/* Collection vs Withdrawal Chart */}
            {pieData.length > 0 && (
              <div className="card">
                <h3>Collection vs Withdrawal</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, value }) => `${name}: ₹${value.toLocaleString('en-IN')}`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => `₹${value.toLocaleString('en-IN')}`} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Trend Chart */}
            {monthlyCollection.length > 0 && (
              <div className="card">
                <h3>Collection Trend (Last 12 Months)</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={monthlyCollection}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" angle={-45} textAnchor="end" height={100} />
                    <YAxis />
                    <Tooltip formatter={(value) => `₹${value.toLocaleString('en-IN')}`} />
                    <Legend />
                    <Bar dataKey="total_collected" fill="#10b981" name="Collection" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Member Details */}
            {report.member_details && (
              <div className="card">
                <h3>Member-wise Details for {report.summary.month}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Member Name</th>
                      <th>Amount Paid</th>
                      <th>Amount Withdrawn</th>
                      <th>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.member_details.map((member, index) => (
                      <tr key={index}>
                        <td>{member.name}</td>
                        <td className="currency">₹{member.paid.toLocaleString('en-IN')}</td>
                        <td className="currency">₹{member.withdrawn.toLocaleString('en-IN')}</td>
                        <td className="currency" style={{ color: (member.paid - member.withdrawn) >= 0 ? '#10b981' : '#ef4444' }}>
                          ₹{(member.paid - member.withdrawn).toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Reports;
