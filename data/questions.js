// The 30 standard teacher appraisal questions, grouped into 8 categories.
// Both the teacher (self-appraisal) and the principal (appraisal) answer the
// exact same 30 questions on the same 1-5 scale, so the two sets of scores
// can be directly compared question-by-question.

const RATING_SCALE = [
  { value: 1, label: "Needs Improvement" },
  { value: 2, label: "Below Average" },
  { value: 3, label: "Satisfactory" },
  { value: 4, label: "Good" },
  { value: 5, label: "Excellent" }
];

const QUESTIONS = [
  // Lesson Planning & Preparation
  { id: 1, category: "Lesson Planning & Preparation", text: "Prepares well-structured lesson plans aligned with the curriculum." },
  { id: 2, category: "Lesson Planning & Preparation", text: "Sets clear, measurable learning objectives for each lesson." },
  { id: 3, category: "Lesson Planning & Preparation", text: "Organizes teaching materials and resources well in advance." },
  { id: 4, category: "Lesson Planning & Preparation", text: "Plans lessons that cater to different learning levels and abilities." },

  // Subject Knowledge & Instructional Delivery
  { id: 5, category: "Subject Knowledge & Instructional Delivery", text: "Demonstrates strong command over the subject matter." },
  { id: 6, category: "Subject Knowledge & Instructional Delivery", text: "Explains concepts clearly using relevant examples." },
  { id: 7, category: "Subject Knowledge & Instructional Delivery", text: "Uses varied teaching methods to keep lessons engaging." },
  { id: 8, category: "Subject Knowledge & Instructional Delivery", text: "Keeps pace with the syllabus/curriculum timeline." },

  // Classroom Management
  { id: 9, category: "Classroom Management", text: "Maintains discipline and a positive learning environment." },
  { id: 10, category: "Classroom Management", text: "Manages classroom time effectively." },
  { id: 11, category: "Classroom Management", text: "Handles disruptive behaviour calmly and fairly." },
  { id: 12, category: "Classroom Management", text: "Ensures a safe and inclusive classroom atmosphere." },

  // Student Engagement & Support
  { id: 13, category: "Student Engagement & Support", text: "Encourages student participation and questions." },
  { id: 14, category: "Student Engagement & Support", text: "Identifies and supports struggling students." },
  { id: 15, category: "Student Engagement & Support", text: "Motivates students to perform to their potential." },
  { id: 16, category: "Student Engagement & Support", text: "Builds positive, respectful relationships with students." },

  // Assessment & Feedback
  { id: 17, category: "Assessment & Feedback", text: "Sets fair and appropriately challenging assessments/tests." },
  { id: 18, category: "Assessment & Feedback", text: "Provides timely and constructive feedback on student work." },
  { id: 19, category: "Assessment & Feedback", text: "Uses assessment data to improve teaching." },
  { id: 20, category: "Assessment & Feedback", text: "Maintains accurate and up-to-date student records." },

  // Communication & Collaboration
  { id: 21, category: "Communication & Collaboration", text: "Communicates effectively with parents/guardians about student progress." },
  { id: 22, category: "Communication & Collaboration", text: "Collaborates well with colleagues and shares best practices." },
  { id: 23, category: "Communication & Collaboration", text: "Follows instructions and supports school policies/administration." },
  { id: 24, category: "Communication & Collaboration", text: "Participates actively in staff meetings and school events." },

  // Professional Growth & Conduct
  { id: 25, category: "Professional Growth & Conduct", text: "Shows punctuality and regularity in attendance." },
  { id: 26, category: "Professional Growth & Conduct", text: "Pursues professional development and learns new skills." },
  { id: 27, category: "Professional Growth & Conduct", text: "Demonstrates professional ethics and integrity." },

  // Use of Technology & Innovation
  { id: 28, category: "Use of Technology & Innovation", text: "Uses digital tools/technology effectively for teaching." },
  { id: 29, category: "Use of Technology & Innovation", text: "Brings innovative and creative ideas into the classroom." },
  { id: 30, category: "Use of Technology & Innovation", text: "Adapts teaching approach based on feedback and reflection." }
];

const CATEGORIES = [...new Set(QUESTIONS.map(q => q.category))];

module.exports = { QUESTIONS, CATEGORIES, RATING_SCALE };
